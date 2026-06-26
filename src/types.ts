export type IssueState = 'triage' | 'backlog' | 'todo' | 'started' | 'done' | 'canceled'

export interface Issue {
  id: string // Linear internal id (used for mutations + state re-reads)
  identifier: string // e.g. BEV-1234
  title: string
  description: string
  estimate: number | null
  priority: number // Linear: 0=none, 1=urgent … 4=low
  createdAt: string // ISO; used for deterministic dispatch ordering
  labels: string[]
  component: string | null // derived from the `area:<x>` label
  blocked: boolean // has a non-terminal "blocks" dependency
  url: string
}

export type Verdict = { ok: true } | { ok: false; reason: string }

export interface RunnerResult {
  ok: boolean
  prUrl?: string
  error?: string
  escalated?: boolean // the agent declined or the ticket vanished mid-run — terminal, do NOT retry
}

export type RunStatus = 'running' | 'retry' | 'pr_open' | 'escalated' | 'failed'

export interface ProcResult {
  ok: boolean
  stdout: string
  combined: string // stdout + stderr + any spawn/timeout cause, for logging
}

export interface Worker {
  readonly kind: string
  run(issue: Issue): Promise<RunnerResult>
}
