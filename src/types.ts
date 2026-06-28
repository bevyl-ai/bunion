// A normalized tracker issue. `state` is the workflow-state NAME; `blockers` come from "blocks" relations.
export interface Issue {
  id: string
  identifier: string
  title: string
  description: string
  url: string
  state: string
  priority: number // 0=none, 1=urgent … 4=low
  createdAt: string // ISO
  startedAt: string | null // ISO — first moved to a started state (the factory-entry clock for total elapsed)
  completedAt: string | null // ISO — when it reached Done
  labels: string[]
  blockers: { state: string | null }[]
  prUrl: string | null // the GitHub PR attached to the issue, if any
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

export interface Config {
  tracker: TrackerConfig
  pollIntervalMs: number
  workspaceRoot: string
  hooks: HooksConfig
  agent: { maxConcurrentAgents: number; maxTurns: number; maxRetryBackoffMs: number }
  phases: Record<string, string[]> // phase name → its states; a worker hands off to a FRESH agent when the ticket crosses phases
  roles: Role[] // the pool — ambient roles run on a cadence beside the per-ticket pipeline
  worker: { sshHosts: string[]; maxPerHost: number } // [] = run agents locally; else fan out across these hosts
  codex: CodexConfig
  deadlock: { tokens: number; stallMs: number; hardStallMs: number } // auto-block a ticket burning resources with no forward progress
  dashboardPort: number | null // status dashboard HTTP port (server.port / BUNION_PORT); null = off
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
}

// A host-side dynamic tool offered to the agent over the app-server (e.g. linear_graphql).
export interface DynamicTool {
  spec: { name: string; description: string; inputSchema: Record<string, unknown> }
  run(args: unknown): Promise<{ success: boolean; output: string }>
}
