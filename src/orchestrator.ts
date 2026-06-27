import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { startAgent, type AgentHandle } from './agent-runner'
import { loadConfig, phaseOf, validateConfig } from './config'
import { startDashboard, type BoardItem, type Snapshot } from './dashboard'
import { fetchBoard, fetchCandidates, fetchLatestNote, fetchStatesByIds, moveIssue, postComment } from './linear'
import { log, warn } from './log'
import { removeWorkspace } from './workspace'
import type { Issue, TokenCounts } from './types'

interface RunningEntry {
  issue: Issue
  handle: AgentHandle
  retryAttempt: number
  startedAt: number
  lastActivity: number
  turn: number
  activity: string
  host: string | null // the worker VM this run is pinned to (null = local)
  phase: string // the pipeline phase this session is running (tokens are attributed here)
  tokenBase: TokenCounts // last-folded thread-cumulative usage, so we add only the delta to the persistent tally
}
interface RetryTimer {
  timer: ReturnType<typeof setTimeout>
  token: number
  identifier: string
  attempt: number
  dueAt: number
}

const CONTINUATION_MS = 1000
const FAILURE_BASE_MS = 10_000

// Per-ticket / per-phase token tracking. codex reports thread-cumulative usage per turn; we fold the delta into a
// tally keyed by issue identifier → phase, persisted to disk so the numbers survive daemon restarts.
const TOKENS_FILE = join(homedir(), '.bunion', 'tokens.json')
const PHASE_ORDER = ['plan', 'build', 'qa', 'verify']
type TokenTally = Record<string, Record<string, TokenCounts>>
const zeroCounts = (): TokenCounts => ({ total: 0, input: 0, output: 0, cached: 0, reasoning: 0 })
const foldDelta = (acc: TokenCounts, cur: TokenCounts, base: TokenCounts): void => {
  acc.total += cur.total - base.total
  acc.input += cur.input - base.input
  acc.output += cur.output - base.output
  acc.cached += cur.cached - base.cached
  acc.reasoning += cur.reasoning - base.reasoning
}
function loadTokens(): TokenTally {
  try {
    const v = JSON.parse(readFileSync(TOKENS_FILE, 'utf8'))
    return v && typeof v === 'object' ? (v as TokenTally) : {}
  } catch {
    return {}
  }
}
function saveTokens(t: TokenTally): void {
  try {
    mkdirSync(dirname(TOKENS_FILE), { recursive: true })
    writeFileSync(TOKENS_FILE, JSON.stringify(t))
  } catch {
    // best effort; tracking is non-critical
  }
}

// The thin harness. Poll the tracker's active states, dispatch a Codex worker per issue (bounded), reconcile
// running issues against the tracker, and retry. It never touches Linear state or git — the AGENT does, via the
// workflow prompt + skills. Faithful to Symphony's orchestrator (SSH pool, blocked-state, dashboard omitted).
export async function start(workflowPath?: string): Promise<void> {
  // Unattended daemon: a stray rejection (flaky VM, transient API error) must never take the whole factory down.
  process.on('unhandledRejection', (e) => warn(`unhandled rejection: ${e instanceof Error ? e.message : String(e)}`))
  let cfg = loadConfig(workflowPath)
  validateConfig(cfg)

  const running = new Map<string, RunningEntry>()
  const claimed = new Set<string>()
  const retries = new Map<string, RetryTimer>()
  let lastBoard: Issue[] = [] // every non-terminal labeled ticket from the last poll — the whole board, not just running
  let tokenSeq = 0

  const logs = new Map<string, string[]>() // per-identifier run log (rolling), kept for the last ~16 runs
  const getLog = (identifier: string): string[] => logs.get(identifier) ?? []
  const summaries = new Map<string, string>() // last agent message per ticket — survives the log buffer, surfaces the human action
  const tokens = loadTokens() // identifier → phase → cumulative token counts; persisted across restarts
  let lastTokenSave = 0
  const notesFetched = new Set<string>() // stuck tickets whose verdict comment we've pulled once for display
  const lastState = new Map<string, string>() // last-seen Linear state per ticket — drops a stale note on transition
  const directives = new Map<string, string>() // operator directive to inject into a ticket's next dispatch (one-shot)

  // Worker placement. An issue is PINNED to one host for its whole life (continuation turns reuse the same VM so the
  // cloned workspace + workpad survive). hostCounts = pinned issues per host; the pin is held until the issue is
  // released (terminal / ineligible / hard-stop), NOT dropped between continuation turns.
  const placement = new Map<string, string>() // issue.id → host
  const hostCounts = new Map<string, number>()
  const hosts = (): string[] => cfg.worker.sshHosts
  const freePlacement = (id: string): void => {
    const h = placement.get(id)
    if (h) hostCounts.set(h, Math.max((hostCounts.get(h) ?? 1) - 1, 0))
    placement.delete(id)
  }
  // Where to run an issue: null = local (no hosts configured); its existing pin if any; else the first host with a
  // free slot; else undefined = every worker is full, wait for one.
  const placeFor = (id: string): string | null | undefined => {
    if (hosts().length === 0) return null
    const pinned = placement.get(id)
    if (pinned && hosts().includes(pinned)) return pinned
    // Spread, don't pack: of the hosts with a free slot, take the least-loaded so VMs fill evenly.
    const free = hosts().filter((h) => (hostCounts.get(h) ?? 0) < cfg.worker.maxPerHost)
    if (free.length === 0) return undefined
    return free.reduce((a, b) => ((hostCounts.get(a) ?? 0) <= (hostCounts.get(b) ?? 0) ? a : b))
  }
  const displayCap = (): number => (hosts().length === 0 ? cfg.agent.maxConcurrentAgents : Math.min(cfg.agent.maxConcurrentAgents, hosts().length * cfg.worker.maxPerHost))

  const slots = (): number => Math.max(cfg.agent.maxConcurrentAgents - running.size, 0)
  const norm = (s: string): string => s.trim().toLowerCase()
  const isTerminal = (s: string): boolean => cfg.tracker.terminalStates.some((t) => norm(t) === norm(s))
  const isActive = (s: string): boolean => cfg.tracker.activeStates.some((t) => norm(t) === norm(s))
  const isRoutable = (i: Issue): boolean => cfg.tracker.requiredLabels.every((l) => i.labels.some((x) => norm(x) === l))
  const planBlocked = (i: Issue): boolean => phaseOf(cfg, i.state) === 'plan' && i.blockers.some((b) => b.state == null || !isTerminal(b.state))
  const eligible = (i: Issue): boolean =>
    isActive(i.state) && !isTerminal(i.state) && isRoutable(i) && !planBlocked(i) && !claimed.has(i.id) && !running.has(i.id)

  const clearRetry = (id: string): void => {
    const r = retries.get(id)
    if (r) {
      clearTimeout(r.timer)
      retries.delete(id)
    }
  }
  const release = (id: string): void => {
    claimed.delete(id)
    clearRetry(id)
    freePlacement(id)
  }
  const terminate = (id: string, cleanup: boolean): void => {
    const e = running.get(id)
    const host = placement.get(id) ?? null
    if (e) {
      e.handle.stop()
      running.delete(id)
    }
    claimed.delete(id)
    clearRetry(id)
    freePlacement(id)
    if (cleanup && e) removeWorkspace(cfg, e.issue.identifier, host)
  }

  const retryDelay = (attempt: number, continuation: boolean): number =>
    continuation && attempt === 1 ? CONTINUATION_MS : Math.min(FAILURE_BASE_MS * 2 ** Math.min(attempt - 1, 10), cfg.agent.maxRetryBackoffMs)

  const scheduleRetry = (id: string, identifier: string, attempt: number, continuation: boolean): void => {
    clearRetry(id)
    const delay = retryDelay(attempt, continuation)
    const token = ++tokenSeq
    const timer = setTimeout(() => void onRetry(id, identifier, attempt, token), delay)
    retries.set(id, { timer, token, identifier, attempt, dueAt: Date.now() + delay })
  }

  const dispatch = (issue: Issue, attempt: number, host: string | null): void => {
    clearRetry(issue.id)
    claimed.add(issue.id)
    if (host && !placement.has(issue.id)) {
      placement.set(issue.id, host)
      hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1)
    }
    logs.delete(issue.identifier)
    logs.set(issue.identifier, []) // fresh log at the newest position
    if (logs.size > 16) {
      const oldest = logs.keys().next().value
      if (oldest && oldest !== issue.identifier) logs.delete(oldest)
    }
    const entry: RunningEntry = { issue, handle: undefined as unknown as AgentHandle, retryAttempt: attempt > 0 ? attempt : 0, startedAt: Date.now(), lastActivity: Date.now(), turn: 0, activity: 'starting…', host, phase: phaseOf(cfg, issue.state), tokenBase: zeroCounts() }
    running.set(issue.id, entry)
    log(`→ ${issue.identifier} (${issue.state})${attempt > 0 ? ` retry#${attempt}` : ''}${host ? ` @ ${host}` : ''}`)
    const directive = directives.get(issue.id) ?? null
    directives.delete(issue.id) // one-shot: consumed by this dispatch's first turn (the comment is the durable fallback)
    entry.handle = startAgent(cfg, issue, attempt > 0 ? attempt : null, host, directive, (e) => {
      entry.lastActivity = Date.now()
      if (e.turn != null) entry.turn = e.turn
      if (e.label != null) entry.activity = e.label
      if (e.log != null) {
        const arr = logs.get(issue.identifier)
        if (arr) {
          arr.push(e.log)
          if (arr.length > 600) arr.splice(0, arr.length - 600)
        }
        if (e.log.startsWith('● ')) summaries.set(issue.identifier, e.log.slice(2, 400)) // keep the latest agent message
      }
      if (e.tokens) {
        // codex sends the thread-cumulative total each turn; fold the delta into this ticket's phase tally.
        const tbl = (tokens[issue.identifier] ??= {})
        const acc = (tbl[entry.phase] ??= zeroCounts())
        foldDelta(acc, e.tokens, entry.tokenBase)
        entry.tokenBase = e.tokens
        const t = Date.now()
        if (t - lastTokenSave > 3000) {
          lastTokenSave = t
          saveTokens(tokens)
        }
      }
    })
    void entry.handle.done.then((outcome) => {
      if (running.get(issue.id) !== entry) return // already terminated by reconcile
      running.delete(issue.id)
      if (outcome.ok) {
        scheduleRetry(issue.id, issue.identifier, 1, true) // re-check & continue while active
        log(`✓ ${issue.identifier} session done`)
      } else {
        const next = entry.retryAttempt > 0 ? entry.retryAttempt + 1 : 1
        scheduleRetry(issue.id, issue.identifier, next, false)
        warn(`✗ ${issue.identifier}: ${(outcome.error ?? '').slice(0, 200)}`)
      }
    })
  }

  async function onRetry(id: string, identifier: string, attempt: number, token: number): Promise<void> {
    if (retries.get(id)?.token !== token) return // superseded
    retries.delete(id)
    let candidates: Issue[]
    try {
      candidates = await fetchCandidates(cfg)
    } catch {
      scheduleRetry(id, identifier, attempt + 1, false)
      return
    }
    const issue = candidates.find((i) => i.id === id)
    if (!issue) return release(id)
    if (isTerminal(issue.state)) {
      removeWorkspace(cfg, issue.identifier, placement.get(id) ?? null)
      return release(id)
    }
    if (!eligible(issue)) return release(id)
    if (slots() <= 0) return scheduleRetry(id, identifier, attempt + 1, false)
    const host = placeFor(id) // a continuation reuses its pinned VM; a fresh retry takes any free worker
    if (host === undefined) return scheduleRetry(id, identifier, attempt + 1, false)
    dispatch(issue, attempt, host)
  }

  async function reconcile(): Promise<void> {
    if (cfg.codex.stallTimeoutMs > 0) {
      const now = Date.now()
      for (const [id, e] of [...running]) {
        if (now - e.lastActivity > cfg.codex.stallTimeoutMs) {
          const next = e.retryAttempt > 0 ? e.retryAttempt + 1 : 1
          terminate(id, false)
          scheduleRetry(id, e.issue.identifier, next, false)
          warn(`stalled ${e.issue.identifier} → retry#${next}`)
        }
      }
    }
    const ids = [...running.keys()]
    if (ids.length === 0) return
    let refreshed: Issue[]
    try {
      refreshed = await fetchStatesByIds(cfg, ids)
    } catch {
      return
    }
    const seen = new Set(refreshed.map((i) => i.id))
    for (const i of refreshed) {
      if (!running.has(i.id)) continue
      if (isTerminal(i.state)) terminate(i.id, true)
      else if (!isRoutable(i)) terminate(i.id, false)
      else if (isActive(i.state)) running.get(i.id)!.issue = i
      else terminate(i.id, false)
    }
    for (const id of ids) if (!seen.has(id) && running.has(id)) terminate(id, false)
  }

  const workerDesc = hosts().length === 0 ? 'local' : `${hosts().length} VM${hosts().length > 1 ? 's' : ''}×${cfg.worker.maxPerHost}`
  log(`bunion up · scope=${cfg.tracker.team ?? cfg.tracker.projectSlug}${cfg.tracker.requiredLabels.length ? ` [${cfg.tracker.requiredLabels.join(',')}]` : ''} · cap=${displayCap()} · workers=${workerDesc} · poll=${cfg.pollIntervalMs}ms`)

  const rankStatus = (s: BoardItem['status']): number => (s === 'running' ? 0 : s === 'retrying' ? 1 : s === 'queued' ? 2 : 3)
  const tokenSummary = (identifier: string): BoardItem['tokens'] => {
    const tbl = tokens[identifier]
    if (!tbl) return null
    const phases = Object.keys(tbl)
      .sort((a, b) => (PHASE_ORDER.indexOf(a) + 1 || 99) - (PHASE_ORDER.indexOf(b) + 1 || 99))
      .map((ph) => ({ phase: ph, ...tbl[ph]! }))
      .filter((p) => p.total > 0)
    const total = phases.reduce((s, p) => s + p.total, 0)
    return total > 0 ? { total, phases } : null
  }
  const snapshot = (): Snapshot => {
    const board = new Map<string, BoardItem>()
    const base = (i: Issue): BoardItem => ({
      identifier: i.identifier, title: i.title, state: i.state, priority: i.priority, host: placement.get(i.id) ?? null, prUrl: i.prUrl,
      url: i.url, note: summaries.get(i.identifier) ?? null,
      status: isActive(i.state) ? 'queued' : 'handoff',
      enteredAt: i.startedAt ? Date.parse(i.startedAt) : null, endedAt: i.completedAt ? Date.parse(i.completedAt) : null,
      turn: 0, activity: '', startedAt: 0, lastActivity: 0, retryAttempt: 0, retryDueAt: null,
      tokens: tokenSummary(i.identifier),
    })
    for (const c of lastBoard) board.set(c.id, base(c))
    for (const [id, r] of retries) {
      const it = board.get(id)
      if (it) {
        it.status = 'retrying'
        it.retryAttempt = r.attempt
        it.retryDueAt = r.dueAt
      }
    }
    for (const [id, e] of running) {
      const it = board.get(id) ?? base(e.issue)
      board.set(id, it)
      it.status = 'running'
      it.state = e.issue.state
      it.title = e.issue.title
      it.turn = e.turn
      it.activity = e.activity
      it.startedAt = e.startedAt
      it.lastActivity = e.lastActivity
      it.retryAttempt = e.retryAttempt
      it.host = e.host
    }
    const items = [...board.values()].sort((a, b) => rankStatus(a.status) - rankStatus(b.status) || rank(a.priority) - rank(b.priority) || a.identifier.localeCompare(b.identifier))
    let totalTokens = 0
    let totalInput = 0
    let totalCached = 0
    for (const ph of Object.values(tokens))
      for (const c of Object.values(ph)) {
        totalTokens += c?.total ?? 0
        totalInput += c?.input ?? 0
        totalCached += c?.cached ?? 0
      }
    return {
      scope: `${cfg.tracker.team ?? cfg.tracker.projectSlug}${cfg.tracker.requiredLabels.length ? ` [${cfg.tracker.requiredLabels.join(',')}]` : ''}`,
      cap: displayCap(),
      pollMs: cfg.pollIntervalMs,
      now: Date.now(),
      items,
      totalTokens,
      totalInput,
      totalCached,
    }
  }
  // Operator actions from the dashboard buttons. to-qa / to-build move the Linear state + wipe the workspace (fresh
  // skills) so the next poll re-dispatches cleanly; restart re-runs in place; all stop any current session first.
  const onAction = async (identifier: string, action: string, directive?: string): Promise<{ ok: boolean; msg?: string }> => {
    const issue = lastBoard.find((i) => i.identifier === identifier)
    if (!issue) return { ok: false, msg: 'ticket not on the board' }
    const host = placement.get(issue.id) ?? null
    const dir = (directive ?? '').trim()
    try {
      // An operator directive: record it as a comment (durable) AND queue it for injection into the next dispatch.
      if (dir) {
        await postComment(cfg, issue.id, `## ⚡ Operator directive\n${dir}`)
        directives.set(issue.id, dir)
      }
      if (action === 'restart') {
        terminate(issue.id, false)
        removeWorkspace(cfg, issue.identifier, host)
        release(issue.id)
        log(`action: ${identifier} restart (operator)${dir ? ' +directive' : ''}`)
        return { ok: true, msg: dir ? 'restarting with your directive' : 'restarting fresh' }
      }
      if (action === 'to-qa' || action === 'to-build') {
        const target = action === 'to-qa' ? 'QA Requested' : 'In Progress'
        terminate(issue.id, false)
        removeWorkspace(cfg, issue.identifier, host)
        await moveIssue(cfg, issue.id, target)
        release(issue.id)
        notesFetched.delete(issue.id)
        summaries.delete(issue.identifier)
        log(`action: ${identifier} → ${target} (operator)${dir ? ' +directive' : ''}`)
        return { ok: true, msg: `moved to ${target}${dir ? ' with your directive' : ''}` }
      }
      return { ok: false, msg: `unknown action: ${action}` }
    } catch (e) {
      return { ok: false, msg: e instanceof Error ? e.message : String(e) }
    }
  }
  if (cfg.dashboardPort) startDashboard(cfg.dashboardPort, snapshot, getLog, log, onAction)

  // Periodic workspace hygiene: each ticket's checkout is ~5-6G (node_modules + git history), and stale ones pile
  // up as tickets cycle across VMs (every restart re-pins and orphans the old copy). Prune workspaces on each VM
  // that aren't currently pinned there AND haven't been touched in 20min. Fire-and-forget; never blocks the loop.
  const pruneWorkspaces = (): void => {
    const hosts = cfg.worker.sshHosts
    if (hosts.length === 0) return
    const keepByHost = new Map<string, string[]>()
    const keep = (h: string, id: string): void => {
      keepByHost.set(h, [...(keepByHost.get(h) ?? []), id])
    }
    for (const e of running.values()) if (e.host) keep(e.host, e.issue.identifier)
    for (const [id, r] of retries) {
      const h = placement.get(id)
      if (h) keep(h, r.identifier)
    }
    for (const host of hosts) {
      const list = `${(keepByHost.get(host) ?? []).join(' ')} SMOKE CLONETEST`
      const cmd = `for d in ~/.bunion/workspaces/*/; do [ -d "$d" ] || continue; id=$(basename "$d"); case " ${list} " in *" $id "*) continue;; esac; [ -z "$(find "$d" -maxdepth 0 -mmin -20 2>/dev/null)" ] && rm -rf "$d"; done`
      spawn('ssh', ['-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', host, cmd], { stdio: 'ignore' }).on('error', () => {})
    }
    log(`workspace prune swept ${hosts.length} VM(s)`)
  }
  if (cfg.worker.sshHosts.length) setInterval(pruneWorkspaces, 20 * 60 * 1000)

  for (;;) {
    try {
      // Reload at the top so reconcile + dispatch both see the same fresh config; keep last-known-good on a bad edit
      // (never skip reconcile because of a config error).
      try {
        const next = loadConfig(workflowPath)
        validateConfig(next)
        cfg = next
      } catch (e) {
        warn(`config: ${e instanceof Error ? e.message : e} (keeping last good)`)
      }
      await reconcile()
      let board: Issue[]
      try {
        // One labeled query is the whole board (active + handed-off). For an unlabeled config, fall back to the
        // active-states query. Either way, narrow host-side to the opt-in set.
        board = (cfg.tracker.requiredLabels.length ? await fetchBoard(cfg) : await fetchCandidates(cfg)).filter(isRoutable)
      } catch (e) {
        warn(`poll: ${e instanceof Error ? e.message : e}`)
        await sleep(cfg.pollIntervalMs)
        continue
      }
      lastBoard = board
      // Surface WHY a ticket is stuck: pull its workpad Verdict for the unblock + needs-human states (not while an
      // agent is live on it — its own messages fill the note then). Clear a cached note when a ticket changes state
      // so a qa-blocked verdict doesn't linger after the unblocker escalates it to Needs human.
      for (const i of board) {
        if (lastState.get(i.id) !== i.state) {
          lastState.set(i.id, i.state)
          summaries.delete(i.identifier)
          notesFetched.delete(i.id)
        }
        const s = norm(i.state)
        if ((s === 'qa blocked' || s === 'needs human') && !running.has(i.id) && !summaries.has(i.identifier) && !notesFetched.has(i.id)) {
          notesFetched.add(i.id)
          void fetchLatestNote(cfg, i.id).then((n) => n && summaries.set(i.identifier, n)).catch(() => {})
        }
      }
      if (slots() > 0) {
        for (const issue of board.filter((i) => isActive(i.state)).sort(byDispatch)) {
          if (slots() <= 0) break
          if (!eligible(issue)) continue
          const host = placeFor(issue.id)
          if (host === undefined) continue // every worker VM is full — try this issue again next poll
          dispatch(issue, 0, host)
        }
      }
    } catch (e) {
      warn(`tick: ${e instanceof Error ? e.message : e}`)
    }
    await sleep(cfg.pollIntervalMs)
  }
}

// Symphony dispatch order: priority (urgent→low, none last), then oldest, then identifier.
function byDispatch(a: Issue, b: Issue): number {
  return rank(a.priority) - rank(b.priority) || (a.createdAt || '9999').localeCompare(b.createdAt || '9999') || (a.identifier || a.id).localeCompare(b.identifier || b.id)
}
function rank(p: number): number {
  return p >= 1 && p <= 4 ? p : 5
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
