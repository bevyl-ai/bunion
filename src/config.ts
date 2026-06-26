import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  // target
  slug: string // owner/name on GitHub
  baseBranch: string
  // linear
  linearApiKey: string
  linearTeam: string // team key, e.g. BEV
  label: string
  // policy
  pollMs: number
  maxConcurrent: number
  maxEstimate: number
  allowlist: string[]
  carveOuts: string[]
  autoMerge: string[] // components allowed to auto-merge; [] = always human
  backpressure: string[] // commands run in the worktree before opening a PR
  maxAttempts: number // failed runs retry up to this many times before a terminal failure
  retryBackoffMs: number // base delay between retries (grows exponentially per attempt)
  // agent
  codexEffort: string
  codexModel: string | null
  codexProvider: string | null // the exe.dev gateway provider id, when set
  codexTimeoutMs: number
  // paths
  workdir: string
  stateDb: string
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
    label: process.env.FACTORY_LABEL ?? 'factory',
    pollMs: num('POLL_MS', 15_000),
    maxConcurrent: num('MAX_CONCURRENT', 3),
    maxEstimate: num('MAX_ESTIMATE', 2),
    allowlist: list('ALLOWLIST', ['copy', 'marketing', 'glossary', 'docs']),
    carveOuts: list('CARVE_OUTS', ['auth', 'billing', 'migrations', 'rls', 'secrets', 'infra']),
    autoMerge: list('AUTO_MERGE', []),
    backpressure: list('BACKPRESSURE', ['bun run typecheck'], ';'),
    maxAttempts: num('MAX_ATTEMPTS', 3),
    retryBackoffMs: num('RETRY_BACKOFF_MS', 30_000),
    codexEffort: process.env.CODEX_EFFORT ?? 'high',
    codexModel: process.env.CODEX_MODEL || null,
    codexProvider: process.env.CODEX_PROVIDER || null,
    codexTimeoutMs: num('CODEX_TIMEOUT_MS', 1_800_000),
    workdir: process.env.WORKDIR || join(home, 'work'),
    stateDb: process.env.STATE_DB || join(home, 'bunion.db'),
    workflowPath: process.env.WORKFLOW_PATH || join(process.cwd(), 'workflow.md'),
  }
}
