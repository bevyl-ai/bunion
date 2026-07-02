import { expect, test } from 'bun:test'
import { deadlockReason, trackProgress } from './orchestrator-deadlock'
import type { ProgressRec } from './orchestrator-state'
import type { Issue } from './types'

const dl = { tokens: 20_000_000, stallMs: 30 * 60_000, hardStallMs: 90 * 60_000 }
const MIN = 60_000

test('fresh ticket is not deadlocked', () => {
  expect(deadlockReason(0, 0, dl)).toBeNull()
})

test('high token burn but not stalled long enough → not deadlocked (still actively working)', () => {
  expect(deadlockReason(25_000_000, 10 * MIN, dl)).toBeNull()
})

test('stalled a while but cheap → not deadlocked (e.g. waiting on an external review)', () => {
  expect(deadlockReason(500_000, 40 * MIN, dl)).toBeNull()
})

test('token budget + stall both exceeded → deadlocked, reason names the spend', () => {
  const r = deadlockReason(25_000_000, 35 * MIN, dl)
  expect(r).toContain('25M')
  expect(r).toContain('no forward progress')
})

test('hard stall trips regardless of token spend', () => {
  expect(deadlockReason(100_000, 95 * MIN, dl)).toContain('stuck')
})

test('exactly at the thresholds counts as deadlocked', () => {
  expect(deadlockReason(dl.tokens, dl.stallMs, dl)).not.toBeNull()
})

// trackProgress — the per-tick forward-progress clock + escalation decision.
const issue = (state: string): Issue => ({
  id: 'i1', identifier: 'BEV-1', title: 't', description: '', state, stateType: 'started', priority: 0, url: '', prUrl: null,
  branchName: null, labels: [], delegateId: null, createdAt: '2026-01-01', updatedAt: null, startedAt: null, completedAt: null, blockers: [],
})
const freshPr = (): ProgressRec => ({ since: 0, tokensAtProgress: 0, seen: new Set() })
const isActive = (s: string): boolean => s === 'In Progress'
const isTerminal = (): boolean => false

test('reaching a new state resets the clock and never deadlocks that tick', () => {
  const pr = freshPr()
  const r = trackProgress(issue('In Progress'), 1000, pr, isActive, isTerminal, false, 0, 200_000_000, dl, false)
  expect(r).toBeNull()
  expect(pr.since).toBe(1000)
  expect(pr.seen.has('in progress')).toBe(true)
})

test('sitting in a seen state past hardStallMs deadlocks, first offense → QA - blocked', () => {
  const pr: ProgressRec = { since: 0, tokensAtProgress: 0, seen: new Set(['in progress']) }
  const r = trackProgress(issue('In Progress'), dl.hardStallMs, pr, isActive, isTerminal, false, 1_000_000, 200_000_000, dl, false)
  expect(r?.target).toBe('QA - blocked')
})

test('a SECOND deadlock (hasDeadlockedBefore) escalates straight to Factory - Needs Engineer', () => {
  const pr: ProgressRec = { since: 0, tokensAtProgress: 0, seen: new Set(['in progress']) }
  const r = trackProgress(issue('In Progress'), dl.hardStallMs, pr, isActive, isTerminal, false, 1_000_000, 200_000_000, dl, true)
  expect(r?.target).toBe('Factory - Needs Engineer')
})

test('hitting the hard token cap escalates straight to Factory - Needs Engineer even with fresh progress', () => {
  const pr: ProgressRec = { since: 999, tokensAtProgress: 0, seen: new Set(['in progress']) }
  const r = trackProgress(issue('In Progress'), 1000, pr, isActive, isTerminal, false, 200_000_000, 200_000_000, dl, false)
  expect(r?.target).toBe('Factory - Needs Engineer')
  expect(r?.reason).toContain('per-ticket cap')
})

// The bug this fixes: a ticket blocked by another Linear issue is dispatch-ineligible by design, so its clock must
// never accrue "no forward progress" time — it isn't stuck, it's correctly waiting.
test('a blocked ticket never deadlocks no matter how long it sits, and its clock keeps pinning to now', () => {
  const pr: ProgressRec = { since: 0, tokensAtProgress: 0, seen: new Set(['backlog']) }
  const r = trackProgress(issue('Backlog'), 10 * dl.hardStallMs, pr, isActive, isTerminal, true, 0, 200_000_000, dl, false)
  expect(r).toBeNull()
  expect(pr.since).toBe(10 * dl.hardStallMs) // pinned to "now", not left at the stale 0
})

test('once unblocked, the clock starts fresh from that moment rather than reading the whole blocked duration as stall', () => {
  // Ticket was blocked and pinned at t=1000 (simulating trackProgress having run with planBlocked=true last tick).
  const pr: ProgressRec = { since: 1000, tokensAtProgress: 0, seen: new Set(['in progress']) }
  // Unblocks at t=1001 — only 1ms has "elapsed" on the clock, nowhere near hardStallMs.
  const r = trackProgress(issue('In Progress'), 1001, pr, isActive, isTerminal, false, 0, 200_000_000, dl, false)
  expect(r).toBeNull()
})
