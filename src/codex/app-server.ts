import { spawn, type ChildProcess } from 'node:child_process'
import type { Config, DynamicTool } from '../types'

type Json = Record<string, unknown>
interface Pending {
  resolve: (v: Json) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Minimal client for the Codex app-server JSON-RPC stream over stdio (newline-delimited JSON, NOT Content-Length).
// One subprocess + one thread per issue; turns run on the same thread. Server→client requests (tool calls,
// approvals, user-input) are answered inline so an unattended turn never stalls. Faithful to Symphony's AppServer.
export class AppServerSession {
  private cfg: Config
  private tools: Map<string, DynamicTool>
  private onEvent: (e: { label?: string }) => void
  private proc: ChildProcess | null = null
  private buf = ''
  private nextId = 100
  private pending = new Map<number, Pending>()
  private turn: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null
  private fatal: Error | null = null

  constructor(cfg: Config, tools: DynamicTool[], onEvent: (e: { label?: string }) => void = () => {}) {
    this.cfg = cfg
    this.tools = new Map(tools.map((t) => [t.spec.name, t]))
    this.onEvent = onEvent
  }

  async start(workspace: string): Promise<void> {
    // bash specifically: `-lc` must source the bash login profile so codex is on PATH and its auth env is present.
    const proc = spawn('bash', ['-lc', this.cfg.codex.command], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    proc.stdout?.on('data', (d: Buffer) => this.onData(d))
    proc.stderr?.on('data', (d: Buffer) => this.onData(d)) // stderr merged; skip non-JSON lines
    proc.on('exit', (code) => this.failAll(new Error(`codex app-server exited (${code})`)))
    proc.on('error', (e) => this.failAll(e instanceof Error ? e : new Error(String(e))))

    await this.request('initialize', {
      capabilities: { experimentalApi: true },
      clientInfo: { name: 'bunion', title: 'bunion', version: '0.2.0' },
    })
    this.notify('initialized', {})
  }

  async startThread(workspace: string): Promise<string> {
    const res = await this.request('thread/start', {
      approvalPolicy: this.cfg.codex.approvalPolicy,
      sandbox: this.cfg.codex.threadSandbox,
      cwd: workspace,
      dynamicTools: [...this.tools.values()].map((t) => t.spec),
    })
    const id = (res.thread as Json | undefined)?.id
    if (typeof id !== 'string') throw new Error('thread/start: missing thread id')
    return id
  }

  // Send one turn and resolve when it terminates (turn/completed). Rejects on turn/failed|cancelled, timeout, or
  // a dead subprocess.
  async runTurn(threadId: string, workspace: string, prompt: string, title: string): Promise<void> {
    if (this.fatal) throw this.fatal
    // Arm the turn waiter BEFORE sending turn/start: a fast turn can stream turn/completed in the same stdout chunk
    // as the turn/start response, so the terminal event needs somewhere to land or it is lost and the turn hangs.
    const turnDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turn = null
        reject(new Error('turn timeout'))
      }, this.cfg.codex.turnTimeoutMs)
      this.turn = {
        resolve: () => {
          clearTimeout(timer)
          this.turn = null
          resolve()
        },
        reject: (e) => {
          clearTimeout(timer)
          this.turn = null
          reject(e)
        },
        timer,
      }
    })
    try {
      await this.request(
        'turn/start',
        {
          threadId,
          input: [{ type: 'text', text: prompt }],
          cwd: workspace,
          title,
          approvalPolicy: this.cfg.codex.approvalPolicy,
          sandboxPolicy: this.cfg.codex.turnSandboxPolicy ?? defaultTurnPolicy(workspace),
        },
        this.cfg.codex.turnTimeoutMs,
      )
    } catch (e) {
      const t = this.turn
      this.turn = null
      if (t) clearTimeout(t.timer)
      throw e
    }
    await turnDone
  }

  stop(): void {
    try {
      this.proc?.kill('SIGKILL')
    } catch {
      // already gone
    }
  }

  // --- internals ---
  private request(method: string, params: Json, timeoutMs = this.cfg.codex.readTimeoutMs): Promise<Json> {
    if (this.fatal) return Promise.reject(this.fatal)
    const id = this.nextId++
    const p = new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    this.send({ method, id, params })
    return p
  }

  private notify(method: string, params: Json): void {
    this.send({ method, params })
  }

  private send(msg: Json): void {
    try {
      this.proc?.stdin?.write(JSON.stringify(msg) + '\n')
    } catch {
      // pipe closed; the exit handler will surface the fatal
    }
  }

  private onData(d: Buffer): void {
    this.buf += d.toString('utf8')
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      const t = line.trim()
      if (!t) continue
      let msg: Json
      try {
        msg = JSON.parse(t) as Json
      } catch {
        continue // stderr noise / partial line
      }
      this.handle(msg)
    }
  }

  private handle(msg: Json): void {
    this.onEvent({})
    const method = typeof msg.method === 'string' ? msg.method : null
    const id = typeof msg.id === 'number' ? msg.id : null

    if (method && id !== null) {
      void this.handleServerRequest(method, id, obj(msg.params))
      return
    }
    if (method) {
      this.handleNotification(method, obj(msg.params))
      return
    }
    if (id !== null) {
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      clearTimeout(p.timer)
      if ('error' in msg) p.reject(new Error(`rpc error: ${JSON.stringify(msg.error)}`))
      else p.resolve(obj(msg.result))
    }
  }

  private async handleServerRequest(method: string, id: number, params: Json): Promise<void> {
    if (method === 'item/tool/call') {
      await this.handleToolCall(id, params)
      return
    }
    const decision = autoApprove(method)
    if (decision) {
      this.reply(id, { decision })
      return
    }
    if (method === 'item/tool/requestUserInput') {
      this.reply(id, { answers: answerUserInput(params) })
      return
    }
    // Any other input-required request → answer benignly so the turn never stalls (approval_policy: never).
    this.reply(id, {})
  }

  private async handleToolCall(id: number, params: Json): Promise<void> {
    const name = typeof params.tool === 'string' ? params.tool : typeof params.name === 'string' ? params.name : ''
    const tool = this.tools.get(name)
    if (!tool) {
      this.reply(id, toolResult(false, `Unsupported dynamic tool: ${name}`))
      return
    }
    try {
      const r = await tool.run(params.arguments ?? {})
      this.reply(id, toolResult(r.success, r.output))
    } catch (e) {
      this.reply(id, toolResult(false, e instanceof Error ? e.message : String(e)))
    }
  }

  private handleNotification(method: string, params: Json): void {
    if (method === 'turn/completed') return void this.turn?.resolve()
    if (method === 'turn/failed') return void this.turn?.reject(new Error('turn failed'))
    if (method === 'turn/cancelled') return void this.turn?.reject(new Error('turn cancelled'))
    if (method === 'item/started') {
      const item = obj(params.item)
      switch (item.type) {
        case 'commandExecution': return this.onEvent({ label: cmdLabel(item) })
        case 'reasoning': return this.onEvent({ label: 'thinking…' })
        case 'fileChange': return this.onEvent({ label: 'editing files' })
        case 'agentMessage': return this.onEvent({ label: 'writing a reply…' })
        case 'mcpToolCall':
        case 'dynamicToolCall': return this.onEvent({ label: 'calling a tool' })
      }
    }
  }

  private reply(id: number, result: Json): void {
    this.send({ id, result })
  }

  private failAll(e: Error): void {
    if (!this.fatal) this.fatal = e
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(e)
    }
    this.pending.clear()
    this.turn?.reject(e)
  }
}

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}
}

function toolResult(success: boolean, output: string): Json {
  return { success, output, contentItems: [{ type: 'inputText', text: output }] }
}

function cmdLabel(item: Json): string {
  const c = item.command
  const s = Array.isArray(c) ? c.map(String).join(' ') : typeof c === 'string' ? c : ''
  if (!s) return 'running a command'
  return `run: ${s.length > 64 ? s.slice(0, 61) + '…' : s}`
}

// Newer item/* approvals want `acceptForSession`; legacy exec/applyPatch approvals want `approved_for_session`.
function autoApprove(method: string): string | null {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return 'acceptForSession'
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') return 'approved_for_session'
  return null
}

function answerUserInput(params: Json): Json {
  const questions = Array.isArray(params.questions) ? (params.questions as Json[]) : []
  const answers: Json = {}
  for (const q of questions) {
    const qid = String(q.id ?? '')
    const labels = (Array.isArray(q.options) ? (q.options as Json[]) : []).map((o) => String(o.label ?? ''))
    const pick =
      labels.find((l) => l === 'Approve this Session') ??
      labels.find((l) => l === 'Approve Once') ??
      labels.find((l) => /^(approve|allow)/i.test(l)) ??
      'This is a non-interactive session. Operator input is unavailable.'
    answers[qid] = { answers: [pick] }
  }
  return answers
}

function defaultTurnPolicy(_workspace: string): Json {
  // The agent runs its own git (fetch/commit/push) + gh. codex's workspace-write write-protects .git regardless of
  // writableRoots, which breaks those, so the agent needs full access to drive git itself. Safe to the extent the
  // host is trusted — the proper containment is running bunion in a disposable VM (the exedev path).
  return { type: 'dangerFullAccess' }
}
