import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  // target
  slug: string // owner/name on GitHub
  baseBranch: string
  // linear
  linearApiKey: string
  linearTeam: string // team key, e.g. BEV
  // states — the board IS the config. Names as they appear in Linear; resolved to ids at startup.
  readyStates: string[] // any of these triggers a pickup (e.g. "Bunion ready", "Rework")
  workingState: string // moved here while the agent runs — the claim
  reviewState: string // moved here when the PR is open
  escalateState: string // moved here when the agent declines or errors
  // run
  pollMs: number
  maxConcurrent: number
  backpressure: string[] // commands run in the worktree before opening a PR; ';'-separated
  // agent
  codexEffort: string
  codexModel: string | null
  codexProvider: string | null // the exe.dev gateway provider id, when set
  codexTimeoutMs: number
  // paths
  workdir: string
  workflowPath: string
}

function req(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing required env: ${name} (copy .env.example → .env)`)
  return v
}

function num(name: string, dflt: number): number {
  const v = process.env[name]
  if (!v) return dflt
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got ${v}`)
  return n
}

function list(name: string, dflt: string[], sep = ','): string[] {
  const v = process.env[name]
  if (v == null) return dflt
  return v
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean)
}

const home = join(homedir(), '.bunion')

export function loadConfig(): Config {
  return {
    slug: req('REPO'),
    baseBranch: process.env.BASE_BRANCH ?? 'main',
    linearApiKey: req('LINEAR_API_KEY'),
    linearTeam: req('LINEAR_TEAM'),
    readyStates: list('READY_STATES', ['Bunion ready']),
    workingState: process.env.WORKING_STATE ?? 'Bunion working',
    reviewState: process.env.REVIEW_STATE ?? 'In review',
    escalateState: process.env.ESCALATE_STATE ?? 'Needs human',
    pollMs: num('POLL_MS', 15_000),
    maxConcurrent: num('MAX_CONCURRENT', 3),
    backpressure: list('BACKPRESSURE', ['bun run typecheck'], ';'),
    codexEffort: process.env.CODEX_EFFORT ?? 'high',
    codexModel: process.env.CODEX_MODEL || null,
    codexProvider: process.env.CODEX_PROVIDER || null,
    codexTimeoutMs: num('CODEX_TIMEOUT_MS', 1_800_000),
    workdir: process.env.WORKDIR || join(home, 'work'),
    workflowPath: process.env.WORKFLOW_PATH || join(process.cwd(), 'workflow.md'),
  }
}
