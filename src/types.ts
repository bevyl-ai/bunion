// A normalized tracker issue. `state` is the workflow-state NAME; `blockers` come from "blocks" relations.
export interface Issue {
  id: string
  identifier: string
  title: string
  description: string
  url: string
  state: string
  priority: number // 0=none, 1=urgent … 4=low
  branchName: string | null // tracker-suggested git branch for the issue (Symphony §4.1.1), null if none
  createdAt: string // ISO
  updatedAt: string | null // ISO — last tracker update (Symphony §4.1.1)
  startedAt: string | null // ISO — first moved to a started state (the factory-entry clock for total elapsed)
  completedAt: string | null // ISO — when it reached Done
  labels: string[] // normalized: trimmed + lowercased (Symphony §4.1.1)
  blockers: { id: string | null; identifier: string | null; state: string | null }[] // each "blocks" relation's source
  prUrl: string | null // the GitHub PR attached to the issue, if any
}

// A categorized failure carrying a STABLE `code` (Symphony §10.6 / §11.4 normalized error categories) so the
// orchestrator + logs can route/label by failure class instead of string-matching free-text messages.
export class CategorizedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CategorizedError'
  }
}
export function errorCode(e: unknown): string | null {
  return e instanceof CategorizedError ? e.code : null
}

// The coding agent's latest rate-limit snapshot (Symphony §4.1.8 codex_rate_limits / §13.3 rate_limits). The upstream
// codex payload evolves, so `raw` carries it verbatim; the summary fields are best-effort for display/backpressure.
export interface RateLimits {
  usedPercent: number | null // primary window utilization 0–100, if known
  resetsInSeconds: number | null // seconds until the primary window resets, if known
  raw: unknown // the full codex rate-limit payload
  at: number // ms epoch the snapshot was captured
}

export interface TrackerConfig {
  kind: string
  endpoint: string
  apiKey: string | null
  appToken: string | null // OAuth actor=app token: the AGENT posts/edits through this so it acts as the app, with a
  // per-phase name via createAsUser. The orchestrator's own reads/operator-actions keep using apiKey (the operator).
  projectSlug: string | null // scope to one project, OR
  team: string | null // scope to a whole team (key, e.g. BEV) — pair with required_labels for opt-in
  requiredLabels: string[] // normalized: trim + lowercase + dedupe; matched host-side (AND)
  activeStates: string[]
  terminalStates: string[]
  minRequestGapMs: number // global min gap (ms) between Linear API requests — paces ALL traffic so we never hammer the API
}

export interface HooksConfig {
  afterCreate: string | null
  beforeRun: string | null
  afterRun: string | null
  beforeRemove: string | null
  timeoutMs: number
}

export interface CodexConfig {
  command: string
  approvalPolicy: string // "never" → auto-approve; passed through to the app-server
  threadSandbox: string // thread/start.params.sandbox (a STRING)
  turnSandboxPolicy: Record<string, unknown> | null // turn/start.params.sandboxPolicy (an OBJECT)
  turnTimeoutMs: number
  readTimeoutMs: number
  initTimeoutMs: number // separate, generous timeout for the cold codex-boot `initialize` handshake (vs steady-state reads)
  stallTimeoutMs: number
}

// A pool role: a generic ambient agent with a standing mission + clock, NOT tied to a ticket. The engine runs each
// configured role on its cadence with a persistent thread (so it remembers prior runs); the role files/tags tickets
// through the same Linear tool the pipeline uses. mechanic + dreamer ship as defaults — add rows, no code change.
export interface Role {
  name: string
  cadenceMs: number // how often this role runs
  prompt: string // the standing mission, sent as the turn each run
  model: string | null // codex model for this role's turns; null = the worker default
  maxPerDay: number | null // max tickets this role may file per UTC day; null = unlimited
}

// A role's daily ticket-filing budget. The orchestrator owns the persisted per-day counter; the linear_graphql tool
// enforces it live (refuses an issueCreate over the cap) and records each filed ticket toward the day's total.
export interface RoleQuota {
  limit: number | null // tickets/day; null = unlimited (no enforcement)
  remaining(): number // how many the role may still file today (Infinity if unlimited)
  record(): void // count one filed ticket toward today's total (persists)
}

export interface BoardColumn {
  name: string
  color: string
  states: string[]
}

export interface Config {
  tracker: TrackerConfig
  pollIntervalMs: number
  workspaceRoot: string
  hooks: HooksConfig
  agent: { maxConcurrentAgents: number; maxConcurrentByState: Record<string, number>; maxTurns: number; maxRetryBackoffMs: number } // global + per-state concurrency caps
  phases: Record<string, string[]> // phase name → its states; a worker hands off to a FRESH agent when the ticket crosses phases
  roles: Role[] // the pool — ambient roles run on a cadence beside the per-ticket pipeline
  worker: { sshHosts: string[]; maxPerHost: number; gatewayAccounts: Record<string, string> } // [] = run agents locally; else fan out across these hosts. gatewayAccounts: llm-integration hostname → ChatGPT account label (display-only)
  codex: CodexConfig
  deadlock: { tokens: number; stallMs: number; hardStallMs: number; hardTokenCap: number } // auto-stop a runaway: no-progress burn, OR an absolute per-ticket total-token ceiling
  dashboardPort: number | null // status dashboard HTTP port (server.port / BUNION_PORT); null = off
  boardColumns: BoardColumn[] // dashboard lanes (name + colour + states), from WORKFLOW.md board.columns; hot-reloaded
  repo: string // default GitHub repo (e.g. bevyl-ai/bevyl.ai); a ticket's repo:<slug> label can route elsewhere via repos
  repos: Record<string, string> // slug -> owner/name; a Linear repo:<slug> label routes that ticket to the mapped repo
  promptTemplate: string
  workflowPath: string
}

// Per-turn token usage, from codex's thread/tokenUsage/updated notification (its thread-cumulative `total`).
export interface TokenCounts {
  total: number
  input: number
  output: number
  cached: number
  reasoning: number
}

// What an app-server session reports up to the orchestrator on each step: progress + the rolling token total.
export interface AgentEvent {
  turn?: number
  label?: string
  log?: string
  tokens?: TokenCounts
  threadId?: string // emitted once when the agent's codex thread is created or resumed, so the orchestrator persists it
  turnId?: string // codex turn id — composes session_id = `${threadId}-${turnId}` (Symphony §4.2 / §10.2)
  event?: string // structured event type: session_started, turn_completed, turn_failed, approval_auto_approved, … (§10.4)
  stream?: string // EPHEMERAL growing agent-message text (realtime streaming); NOT persisted — item/completed commits the final `● ` log line
  ts?: string // ISO-8601 UTC timestamp of the event (§10.4)
  rateLimits?: RateLimits // latest coding-agent rate-limit snapshot, when codex reports one (§10.4 / §13.3)
}

// A host-side dynamic tool offered to the agent over the app-server (e.g. linear_graphql).
export interface DynamicTool {
  spec: { name: string; description: string; inputSchema: Record<string, unknown> }
  run(args: unknown): Promise<{ success: boolean; output: string }>
}
