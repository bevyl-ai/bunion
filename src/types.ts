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
  labels: string[]
  blockers: { state: string | null }[]
}

export interface TrackerConfig {
  kind: string
  endpoint: string
  apiKey: string | null
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

export interface Config {
  tracker: TrackerConfig
  pollIntervalMs: number
  workspaceRoot: string
  hooks: HooksConfig
  agent: { maxConcurrentAgents: number; maxTurns: number; maxRetryBackoffMs: number }
  codex: CodexConfig
  dashboardPort: number | null // status dashboard HTTP port (server.port / BUNION_PORT); null = off
  promptTemplate: string
  workflowPath: string
}

// A host-side dynamic tool offered to the agent over the app-server (e.g. linear_graphql).
export interface DynamicTool {
  spec: { name: string; description: string; inputSchema: Record<string, unknown> }
  run(args: unknown): Promise<{ success: boolean; output: string }>
}
