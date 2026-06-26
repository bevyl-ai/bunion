import type { Config } from './config'

export interface Issue {
  id: string // Linear internal id (used for mutations + state re-reads)
  identifier: string // e.g. BEV-1234
  title: string
  description: string
  url: string
  comments: string[] // recent human/review comments — the feedback channel for re-runs
}

export interface ResolvedStates {
  ready: string[] // state ids that trigger a pickup
  working: string
  review: string
  escalate: string
}

// Everything the daemon and the runner need, resolved once at startup.
export interface Runtime {
  cfg: Config
  states: ResolvedStates
}

export interface RunnerResult {
  ok: boolean
  prUrl?: string
  error?: string
  escalated?: boolean // agent declined or the ticket left the working state — affects the comment wording only
}

export interface ProcResult {
  ok: boolean
  stdout: string
  combined: string // stdout + stderr + any spawn/timeout cause, for logging
}

export interface Worker {
  readonly kind: string
  run(issue: Issue): Promise<RunnerResult>
}
