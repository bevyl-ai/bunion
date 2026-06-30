import { expect, test } from 'bun:test'
import { deadlockReason, resolveTokenBase } from './orchestrator'
import { zeroCounts } from './tokens'

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

// BEV audit (CRITICAL): codex reports THREAD-cumulative tokens. Resetting tokenBase to zero on every redispatch
// meant a session that RESUMED an existing thread re-folded the WHOLE thread's history-to-date on top of a tally
// that already had it — the actual root cause behind tickets reaching billions of tokens before the 200M cap ever
// caught them. These prove the fix: seed from the persisted total on a true resume, stay at zero otherwise.
const counts = (total: number): ReturnType<typeof zeroCounts> => ({ ...zeroCounts(), total })

test('a session that truly resumes its thread seeds tokenBase from the persisted total (the fix)', () => {
  const prior = counts(1_200_000)
  expect(resolveTokenBase('thread-A', 'thread-A', prior)).toEqual(prior)
})

test('a genuinely fresh thread (first dispatch ever, no prior record) starts at zero', () => {
  expect(resolveTokenBase('thread-A', null, null)).toEqual(zeroCounts())
})

test('a failed resume that falls back to a NEW thread starts at zero, not the old thread\'s total — seeding it would go negative', () => {
  const prior = counts(1_200_000)
  expect(resolveTokenBase('thread-B-fallback', 'thread-A', prior)).toEqual(zeroCounts())
})

test('a resume we intended but have no persisted total for yet starts at zero (no prior session ever folded)', () => {
  expect(resolveTokenBase('thread-A', 'thread-A', null)).toEqual(zeroCounts())
})
