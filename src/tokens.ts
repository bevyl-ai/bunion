import type { TokenCounts } from './types'

// Per-ticket (and per-role) token usage, keyed identifier → phase → counts. codex reports its thread-cumulative
// usage each turn; the orchestrator folds the per-turn delta into whichever phase the worker is running, so spend
// is attributed to plan/build/qa/verify/unblock independently (roles accumulate under a single `pool` phase).
export type TokenTally = Record<string, Record<string, TokenCounts>>

export interface PhaseTokens extends TokenCounts {
  phase: string
}
export interface TokenBreakdown {
  total: number
  phases: PhaseTokens[]
}

// Pipeline phases in display order; anything else (e.g. a role's `pool`) sorts after. Mirrors WORKFLOW.md phases.
const PHASE_ORDER = ['plan', 'build', 'qa', 'verify', 'unblock']

export const zeroCounts = (): TokenCounts => ({ total: 0, input: 0, output: 0, cached: 0, reasoning: 0 })

// Add (cur − base) into `acc`, field by field. `cur` is codex's running cumulative for the session and `base` is
// the previous cumulative, so the difference is the usage since the last update.
export function foldDelta(acc: TokenCounts, cur: TokenCounts, base: TokenCounts): void {
  acc.total += cur.total - base.total
  acc.input += cur.input - base.input
  acc.output += cur.output - base.output
  acc.cached += cur.cached - base.cached
  acc.reasoning += cur.reasoning - base.reasoning
}

// One ticket's usage broken out per phase (in pipeline order) with the across-phase total — or null if it has
// spent nothing yet. Drives the dashboard's per-stage token display.
export function phaseBreakdown(tally: TokenTally, identifier: string): TokenBreakdown | null {
  const tbl = tally[identifier]
  if (!tbl) return null
  const phases: PhaseTokens[] = Object.keys(tbl)
    .sort((a, b) => (PHASE_ORDER.indexOf(a) + 1 || 99) - (PHASE_ORDER.indexOf(b) + 1 || 99))
    .map((phase) => ({ phase, ...tbl[phase]! }))
    .filter((p) => p.total > 0)
  const total = phases.reduce((s, p) => s + p.total, 0)
  return total > 0 ? { total, phases } : null
}

// Every token a ticket has spent across all of its phases — the figure deadlock accounting burns down.
export function grandTotal(tally: TokenTally, identifier: string): number {
  return Object.values(tally[identifier] ?? {}).reduce((s, c) => s + (c?.total ?? 0), 0)
}

// Project-wide totals across every tracked ticket and role.
export function totals(tally: TokenTally): { total: number; input: number; output: number; cached: number } {
  const sum = { total: 0, input: 0, output: 0, cached: 0 }
  for (const phases of Object.values(tally))
    for (const c of Object.values(phases)) {
      sum.total += c?.total ?? 0
      sum.input += c?.input ?? 0
      sum.output += c?.output ?? 0
      sum.cached += c?.cached ?? 0
    }
  return sum
}

// API-equivalent $ at ~GPT-5.5 rates ($ per 1M tokens) — uncached input + output are the cost, cached input is cheap.
// Actual spend is the flat $200/mo ChatGPT Pro plan, so apiCost is the value extracted (not what's paid); planCost
// prices the same compute at the plan's effective rate (~$200 per ~$14k of API-equivalent the plan is worth if fully
// used). The dashboard's client JS mirrors these constants — keep them in sync.
export const RATES = { input: 5, cached: 0.5, output: 30, planMonthly: 200, planApiValue: 14000 }
export function apiCost(c: { input: number; output: number; cached: number }): number {
  return (Math.max(0, c.input - c.cached) * RATES.input + c.cached * RATES.cached + c.output * RATES.output) / 1e6
}
export function planCost(c: { input: number; output: number; cached: number }): number {
  return (apiCost(c) * RATES.planMonthly) / RATES.planApiValue
}
