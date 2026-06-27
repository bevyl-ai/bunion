import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseWorkflow } from './workflow'
import type { Config, TrackerConfig } from './types'

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}
function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

// `$VAR` → env; literal otherwise. Missing/empty env → fall back to canonical env, then null.
function secret(v: unknown, fallbackEnv: string): string | null {
  const s = str(v)
  if (s == null) return process.env[fallbackEnv] || null
  const m = s.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)
  if (m) {
    const e = process.env[m[1]!]
    if (e === undefined) return process.env[fallbackEnv] || null
    return e === '' ? null : e
  }
  return s || null
}

function pathValue(v: unknown, dflt: string): string {
  const s = str(v)
  if (s == null || s === '') return dflt
  const m = s.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)
  if (m) return process.env[m[1]!] || dflt
  return s
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p
}

export function loadConfig(path?: string): Config {
  const workflowPath = path ?? join(process.cwd(), 'WORKFLOW.md')
  const { frontmatter: fm, prompt } = parseWorkflow(workflowPath)

  const tk = obj(fm.tracker)
  const tracker: TrackerConfig = {
    kind: str(tk.kind) ?? '',
    endpoint: str(tk.endpoint) ?? 'https://api.linear.app/graphql',
    apiKey: secret(tk.api_key, 'LINEAR_API_KEY'),
    appToken: secret(tk.app_token, 'LINEAR_APP_TOKEN'),
    projectSlug: secret(tk.project_slug, 'LINEAR_PROJECT_SLUG'),
    team: secret(tk.team, 'LINEAR_TEAM'),
    requiredLabels: [...new Set(arr(tk.required_labels).map((l) => l.trim().toLowerCase()).filter(Boolean))],
    activeStates: arr(tk.active_states).length ? arr(tk.active_states) : ['Todo', 'In Progress'],
    terminalStates: arr(tk.terminal_states).length ? arr(tk.terminal_states) : ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'],
  }

  const poll = obj(fm.polling)
  const ws = obj(fm.workspace)
  const hk = obj(fm.hooks)
  const ag = obj(fm.agent)
  const wk = obj(fm.worker)
  const cx = obj(fm.codex)
  const envHosts = (process.env.BUNION_SSH_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const srv = obj(fm.server)
  const portRaw = process.env.BUNION_PORT ?? (typeof srv.port === 'number' ? String(srv.port) : null)

  let workspaceRoot = expandHome(pathValue(ws.root, join(tmpdir(), 'bunion_workspaces')))
  if (!isAbsolute(workspaceRoot)) workspaceRoot = resolve(dirname(workflowPath), workspaceRoot)

  return {
    tracker,
    pollIntervalMs: num(poll.interval_ms, 30_000),
    workspaceRoot,
    hooks: {
      afterCreate: str(hk.after_create),
      beforeRun: str(hk.before_run),
      afterRun: str(hk.after_run),
      beforeRemove: str(hk.before_remove),
      timeoutMs: num(hk.timeout_ms, 60_000),
    },
    agent: {
      maxConcurrentAgents: num(ag.max_concurrent_agents, 10),
      maxTurns: num(ag.max_turns, 20),
      maxRetryBackoffMs: num(ag.max_retry_backoff_ms, 300_000),
    },
    phases: Object.fromEntries(Object.entries(obj(fm.phases)).map(([k, v]) => [k, arr(v)])),
    worker: {
      sshHosts: arr(wk.ssh_hosts).length ? arr(wk.ssh_hosts) : envHosts,
      maxPerHost: num(wk.max_concurrent_agents_per_host, 1),
    },
    codex: {
      command: str(cx.command) ?? 'codex app-server',
      approvalPolicy: str(cx.approval_policy) ?? 'never',
      threadSandbox: str(cx.thread_sandbox) ?? 'workspace-write',
      turnSandboxPolicy: cx.turn_sandbox_policy && typeof cx.turn_sandbox_policy === 'object' && !Array.isArray(cx.turn_sandbox_policy) ? (cx.turn_sandbox_policy as Record<string, unknown>) : null,
      turnTimeoutMs: num(cx.turn_timeout_ms, 3_600_000),
      readTimeoutMs: num(cx.read_timeout_ms, 5_000),
      stallTimeoutMs: num(cx.stall_timeout_ms, 300_000),
    },
    dashboardPort: portRaw && Number.isFinite(Number(portRaw)) ? Number(portRaw) : null,
    promptTemplate: prompt,
    workflowPath,
  }
}

// Which pipeline phase a state belongs to. Unmapped states are their own phase, so crossing into one (e.g. a
// build worker setting `Ready to ship`) still reads as a handoff. Matching ignores case + surrounding whitespace.
export function phaseOf(cfg: Config, state: string): string {
  const n = state.trim().toLowerCase()
  for (const [phase, states] of Object.entries(cfg.phases)) {
    if (states.some((s) => s.trim().toLowerCase() === n)) return phase
  }
  return n
}

// Dispatch preflight — throws on the config errors that block any work.
export function validateConfig(cfg: Config): void {
  if (!cfg.tracker.kind) throw new Error('tracker.kind is required')
  if (cfg.tracker.kind !== 'linear') throw new Error(`unsupported tracker.kind: ${cfg.tracker.kind}`)
  if (!cfg.tracker.apiKey) throw new Error('tracker.api_key missing — set LINEAR_API_KEY')
  if (!cfg.tracker.team && !cfg.tracker.projectSlug) throw new Error('scope missing — set tracker.team (LINEAR_TEAM) or tracker.project_slug (LINEAR_PROJECT_SLUG)')
  if (!cfg.codex.command) throw new Error('codex.command is required')
}
