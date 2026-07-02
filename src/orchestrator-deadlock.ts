import type { ProgressRec } from './orchestrator-state'
import type { Config, Issue } from './types'

export interface StuckTicket {
  issue: Issue
  target: string
  reason: string
}

const norm = (s: string): string => s.trim().toLowerCase()

// Forward-progress clock + deadlock decision for one ticket, called once per poll tick. Reaching a not-yet-seen
// pipeline state resets the clock; sitting in already-seen states burns it down. Mutates `pr` in place (the caller
// owns persisting the Map via saveProgress()) and returns a StuckTicket if this ticket should be auto-escalated.
//
// `dispatchBlocked` (blocked-by-another-issue) is semi-terminal for this clock: it isn't dispatch-eligible, so it
// genuinely can't make progress — that's correct, not stuck. Its clock keeps pinning to "now" every tick it stays
// blocked, so the moment the blocker clears it starts fresh and fair instead of instantly reading as having
// silently deadlocked for however long the block lasted.
export function trackProgress(
  issue: Issue,
  now: number,
  pr: ProgressRec,
  isActive: (state: string) => boolean,
  isTerminal: (state: string) => boolean,
  dispatchBlocked: boolean,
  totalTokens: number,
  effectiveCap: number,
  dl: Omit<Config['deadlock'], 'hardTokenCap'>,
  hasDeadlockedBefore: boolean,
): StuckTicket | null {
  if (!pr.seen.has(norm(issue.state))) {
    pr.seen.add(norm(issue.state))
    pr.since = now
    pr.tokensAtProgress = totalTokens
  }
  if (dispatchBlocked) {
    pr.since = now
    pr.tokensAtProgress = totalTokens
    return null
  }
  if (!isActive(issue.state) || isTerminal(issue.state)) return null
  if (totalTokens >= effectiveCap) {
    // Absolute blast-radius cap (plus any operator budget bump): even a ticket that keeps reaching new states
    // (which resets the no-progress clock) must never burn unbounded. Straight to Factory - Needs Engineer.
    return { issue, target: 'Factory - Needs Engineer', reason: `burned ${Math.round(totalTokens / 1e6)}M tokens — hit the ${Math.round(effectiveCap / 1e6)}M per-ticket cap` }
  }
  // No-progress deadlock: a ticket deadlocking while IN `QA - blocked` means the triage itself is looping →
  // straight to Factory - Needs Engineer. Anywhere else: 1st offense → QA - blocked (let it triage), 2nd → Factory - Needs Engineer.
  const reason = deadlockReason(totalTokens - pr.tokensAtProgress, now - pr.since, dl)
  if (!reason) return null
  return { issue, target: norm(issue.state) === 'qa - blocked' || hasDeadlockedBefore ? 'Factory - Needs Engineer' : 'QA - blocked', reason }
}

// A ticket is deadlocked when it keeps spending tokens/time without advancing to a pipeline state it hasn't
// reached this lifecycle (e.g. oscillating In Progress ↔ QA - Testing, or a fix that never lands). Returns a
// human-readable reason or null. Pure so it's unit-testable.
export function deadlockReason(tokensSinceProgress: number, msSinceProgress: number, dl: Omit<Config['deadlock'], 'hardTokenCap'>): string | null {
  const mins = Math.round(msSinceProgress / 60_000)
  if (msSinceProgress >= dl.hardStallMs) return `stuck ${mins}min with no forward progress`
  if (tokensSinceProgress >= dl.tokens && msSinceProgress >= dl.stallMs)
    return `burned ${(tokensSinceProgress / 1e6).toFixed(0)}M tokens over ${mins}min with no forward progress`
  return null
}
