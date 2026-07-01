import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseWorkflow } from './workflow'
import type { BoardColumn, Config, TrackerConfig } from './types'

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
// A normalized state→positive-int map (per-state concurrency caps). Keys are trimmed + lowercased for lookup;
// non-numeric / non-integer / non-positive entries are dropped (Symphony §5.3.5).
function intMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, val] of Object.entries(obj(v))) if (typeof val === 'number' && Number.isInteger(val) && val > 0) out[k.trim().toLowerCase()] = val
  return out
}
// A string→string map (e.g. llm-gateway hostname → ChatGPT account label). Non-string values dropped; keys trimmed.
function strMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(obj(v))) if (typeof val === 'string') out[k.trim()] = val
  return out
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

// A role cadence: a bare number is ms; "30m" / "4h" / "1d" / "45s" are human durations. 0 = invalid (role skipped).
function parseCadence(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const m = (str(v) ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i)
  if (!m) return 0
  const mult: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  return Math.round(parseFloat(m[1]!) * (mult[(m[2] ?? 'm').toLowerCase()] ?? 60_000))
}

// Dashboard lanes, left→right. The default; WORKFLOW.md `board.columns` overrides it and is hot-reloaded each poll,
// so renaming a lane needs no restart.
const DEFAULT_COLUMNS: BoardColumn[] = [
  { name: 'Planning', color: '#8b93a1', states: ['Triage', 'Backlog', 'Todo'] },
  { name: 'In Progress', color: '#5b8def', states: ['In Progress'] },
  { name: 'QA check', color: '#d99a2b', states: ['QA - Testing'] },
  { name: 'Blocked', color: '#e0564f', states: ['QA - blocked'] },
  { name: 'QA - Requested', color: '#d9a441', states: ['QA - Requested'] },
  { name: 'Factory - UI review', color: '#b88cd9', states: ['Factory - UI review'] },
  { name: 'Ready', color: '#3fb27f', states: ['STG - Ready to merge'] },
  { name: 'In Staging', color: '#e3b341', states: ['STG - Merged'] },
  { name: 'Verifying prod', color: '#4a9eda', states: ['Verifying in Prod'] },
  { name: "Factory - can't verify", color: '#e0864f', states: ["Factory - can't verify"] },
  { name: 'Factory - Needs Engineer', color: '#d9568c', states: ['Factory - Needs Engineer'] },
  { name: 'Done', color: '#6b7280', states: ['Done'] },
]
function parseColumns(v: unknown): BoardColumn[] {
  const cols = (Array.isArray(v) ? v : []).map(obj).map((c) => ({ name: str(c.name) ?? '', color: str(c.color) ?? '#6b7280', states: arr(c.states) })).filter((c) => c.name && c.states.length > 0)
  return cols.length ? cols : DEFAULT_COLUMNS
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
    appActorId: secret(tk.app_actor_id, 'LINEAR_APP_ACTOR_ID'),
    requiredLabels: [...new Set(arr(tk.required_labels).map((l) => l.trim().toLowerCase()).filter(Boolean))],
    activeStates: arr(tk.active_states).length ? arr(tk.active_states) : ['Todo', 'In Progress'],
    terminalStates: arr(tk.terminal_states).length ? arr(tk.terminal_states) : ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'],
    minRequestGapMs: num(tk.min_request_gap_ms, 250), // global min gap between Linear requests — pace all traffic (orchestrator + agents)
  }

  const poll = obj(fm.polling)
  const ws = obj(fm.workspace)
  const hk = obj(fm.hooks)
  const ag = obj(fm.agent)
  const wk = obj(fm.worker)
  const cx = obj(fm.codex)
  const dl = obj(fm.deadlock)
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
      maxConcurrentByState: intMap(ag.max_concurrent_agents_by_state), // per-state concurrency caps (Symphony §5.3.5); {} = global cap only
      maxTurns: num(ag.max_turns, 20),
      maxRetryBackoffMs: num(ag.max_retry_backoff_ms, 300_000),
    },
    phases: Object.fromEntries(Object.entries(obj(fm.phases)).map(([k, v]) => [k, arr(v)])),
    roles: (Array.isArray(fm.roles) ? fm.roles : [])
      .map(obj)
      .map((r) => ({ name: (str(r.name) ?? '').trim(), cadenceMs: parseCadence(r.cadence), prompt: str(r.prompt) ?? '', model: str(r.model), maxPerDay: typeof r.max_per_day === 'number' && Number.isFinite(r.max_per_day) ? r.max_per_day : null }))
      .filter((r) => r.name && r.prompt && r.cadenceMs > 0),
    worker: {
      sshHosts: arr(wk.ssh_hosts).length ? arr(wk.ssh_hosts) : envHosts,
      maxPerHost: num(wk.max_concurrent_agents_per_host, 1),
      gatewayAccounts: strMap(wk.gateway_accounts), // llm-integration hostname → ChatGPT account label (display-only tracking)
    },
    codex: {
      command: str(cx.command) ?? 'codex app-server',
      approvalPolicy: str(cx.approval_policy) ?? 'never',
      threadSandbox: str(cx.thread_sandbox) ?? 'workspace-write',
      turnSandboxPolicy: cx.turn_sandbox_policy && typeof cx.turn_sandbox_policy === 'object' && !Array.isArray(cx.turn_sandbox_policy) ? (cx.turn_sandbox_policy as Record<string, unknown>) : null,
      turnTimeoutMs: num(cx.turn_timeout_ms, 3_600_000),
      readTimeoutMs: num(cx.read_timeout_ms, 5_000),
      initTimeoutMs: num(cx.init_timeout_ms, 60_000), // cold codex boot on a fresh/loaded VM far exceeds a steady-state read
      stallTimeoutMs: num(cx.stall_timeout_ms, 300_000),
    },
    deadlock: {
      tokens: num(dl.tokens, 20_000_000), // tokens burned with no new pipeline state (within stallMs) → blocked
      stallMs: num(dl.stall_ms, 30 * 60_000), // ...with no forward progress for at least this long
      hardStallMs: num(dl.hard_stall_ms, 90 * 60_000), // OR this long with no progress, regardless of token spend
      hardTokenCap: num(dl.hard_token_cap, 200_000_000), // absolute per-ticket total-spend ceiling → Factory - Needs Engineer, regardless of progress (blast-radius cap)
    },
    dashboardPort: portRaw && Number.isFinite(Number(portRaw)) ? Number(portRaw) : null,
    boardColumns: parseColumns(obj(fm.board).columns),
    repo: str(fm.repo) ?? process.env.REPO ?? 'bevyl-ai/bevyl.ai', // default repo (also the workers' $REPO fallback)
    repos: Object.fromEntries(Object.entries(obj(fm.repos)).map(([k, v]) => [k.trim().toLowerCase(), str(v)]).filter((e): e is [string, string] => !!e[1])), // repo:<slug> label -> owner/name
    promptTemplate: prompt,
    workflowPath,
  }
}

// Resolve a ticket's target repo: a `repo:<slug>` label mapped via `repos`, else the default `repo`. Labels arrive
// lowercased. This is what lets bunion drive more than one repo from a single board.
export function repoFor(cfg: Config, labels: string[]): string {
  for (const l of labels) {
    const m = /^repo:(.+)$/.exec(l)
    if (m) {
      const r = cfg.repos[m[1]!.trim().toLowerCase()]
      if (r) return r
    }
  }
  return cfg.repo
}

// Which pipeline phase a state belongs to. Unmapped states are their own phase, so crossing into one (e.g. a
// build worker setting `STG - Ready to merge`) still reads as a handoff. Matching ignores case + surrounding whitespace.
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
