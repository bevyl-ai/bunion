// Client-side mirrors of the server's BoardItem/RoleItem/Snapshot shapes (src/dashboard.ts). Duplicated rather
// than imported because the client bundle must not pull in server-only modules (bun:sqlite via stats.ts, etc.)
// through a shared import graph — these types are structurally identical to the wire JSON the server emits.

export interface TokenPhase {
  phase: string
  total: number
  input: number
  output: number
  cached: number
  reasoning: number
}
export interface TokenBreakdown {
  total: number
  phases: TokenPhase[]
}

export interface BoardItem {
  identifier: string
  title: string
  state: string
  priority: number
  host: string | null
  prUrl: string | null
  url: string
  note: string | null
  status: 'running' | 'retrying' | 'queued' | 'handoff'
  enteredAt: number | null
  endedAt: number | null
  turn: number
  activity: string
  startedAt: number
  lastActivity: number
  retryAttempt: number
  retryDueAt: number | null
  tokens: TokenBreakdown | null
}

export interface RoleItem {
  name: string
  status: 'running' | 'idle'
  activity: string
  model: string | null
  host: string | null
  tokens: number
  cadenceMs: number
  lastRunAt: number | null
  filedToday: number
  maxPerDay: number | null
  granted: number
  paused: boolean
}

export interface RateLimits {
  usedPercent: number | null
  resetsInSeconds: number | null
  raw: unknown
  at: number
}

export interface BoardColumn {
  name: string
  c: string
  states: string[]
  inert?: boolean
}

export interface PollHealth {
  failureStreak: number
  lastError: string | null
  lastOkAt: number | null
}

export interface Snapshot {
  scope: string
  cap: number
  items: BoardItem[]
  totalTokens: number
  totalInput: number
  totalOutput: number
  totalCached: number
  paused: boolean
  rateLimits: RateLimits | null
  secondsRunning: number
  roles: RoleItem[]
  columns: BoardColumn[]
  terminalStates?: string[]
  gatewayAccounts: string[]
  pollHealth?: PollHealth
}

// Default board lanes — mirrors src/config.ts's DEFAULT_COLUMNS, used only until the first snapshot arrives
// (snapshot.columns is hot-reloadable and always wins once present).
export const DEFAULT_COLUMNS: BoardColumn[] = [
  { name: 'Planning', c: '#8b93a1', states: ['Triage', 'Backlog', 'Todo'] },
  { name: 'In Progress', c: '#5b8def', states: ['In Progress'] },
  { name: 'QA Requested', c: '#d9a441', states: ['QA Requested'], inert: true },
  { name: 'QA check', c: '#d99a2b', states: ['QA Testing'] },
  { name: 'Verify QA', c: '#c79a3a', states: ['QA Verify'] },
  { name: 'Blocked', c: '#e0564f', states: ['QA blocked'] },
  { name: 'Needs Engineer', c: '#d9568c', states: ['Needs Engineer'], inert: true },
  { name: 'Ready', c: '#3fb27f', states: ['STG - Ready to merge'], inert: true },
  { name: 'In Staging', c: '#e3b341', states: ['STG - Merged'], inert: true },
  { name: 'Verifying prod', c: '#4a9eda', states: ['Verifying in Prod'] },
  { name: 'Done', c: '#6b7280', states: ['Done'], inert: true },
]

export interface ActionDef {
  a: string // action id sent to POST /action
  l: string // button label
  c?: 'go' | 'danger' | ''
  t?: string // tooltip
}
