import { expect, test } from 'bun:test'
import { foldDelta, grandTotal, phaseBreakdown, resolveTokenBase, totals, zeroCounts, type TokenTally } from './tokens'

const counts = (total: number, input = 0, output = 0, cached = 0, reasoning = 0) => ({ total, input, output, cached, reasoning })

test('foldDelta adds the cumulative delta (cur − base) into the accumulator', () => {
  const acc = zeroCounts()
  foldDelta(acc, counts(100, 60, 40, 10, 5), zeroCounts()) // first update of a session: base is 0
  expect(acc).toEqual(counts(100, 60, 40, 10, 5))
  foldDelta(acc, counts(250, 150, 100, 25, 12), counts(100, 60, 40, 10, 5)) // next cumulative report
  expect(acc).toEqual(counts(250, 150, 100, 25, 12)) // only the delta is added, so acc tracks the latest cumulative
})

test('phaseBreakdown is null when the ticket has no usage', () => {
  expect(phaseBreakdown({}, 'BEV-1')).toBeNull()
  expect(phaseBreakdown({ 'BEV-1': { build: zeroCounts() } }, 'BEV-1')).toBeNull()
})

test('phaseBreakdown orders by pipeline phase, drops empty phases, and totals', () => {
  const tally: TokenTally = { 'BEV-1': { qa: counts(30), plan: counts(20), blocked: counts(0), build: counts(50) } }
  const b = phaseBreakdown(tally, 'BEV-1')!
  expect(b.total).toBe(100)
  expect(b.phases.map((p) => p.phase)).toEqual(['plan', 'build', 'qa']) // pipeline order; the empty `blocked` is dropped
})

test('grandTotal sums every phase for one ticket, 0 for an unknown one', () => {
  const tally: TokenTally = { 'BEV-1': { plan: counts(20), build: counts(50) }, 'BEV-2': { qa: counts(999) } }
  expect(grandTotal(tally, 'BEV-1')).toBe(70)
  expect(grandTotal(tally, 'absent')).toBe(0)
})

test('totals sum across every ticket and role', () => {
  const tally: TokenTally = { 'BEV-1': { build: counts(50, 30, 20, 5) }, mechanic: { pool: counts(10, 6, 4, 1) } }
  expect(totals(tally)).toEqual({ total: 60, input: 36, output: 24, cached: 6 })
})

// BEV audit (CRITICAL): codex reports THREAD-cumulative tokens. Resetting tokenBase to zero on every redispatch
// meant a session that RESUMED an existing thread re-folded the WHOLE thread's history-to-date on top of a tally
// that already had it — the actual root cause behind tickets reaching billions of tokens before the 200M cap ever
// caught them. These prove the fix: seed from the persisted total on a true resume, stay at zero otherwise.
const tc = (total: number): ReturnType<typeof zeroCounts> => ({ ...zeroCounts(), total })

test('a session that truly resumes its thread seeds tokenBase from the persisted total (the fix)', () => {
  const prior = tc(1_200_000)
  expect(resolveTokenBase('thread-A', 'thread-A', prior)).toEqual(prior)
})

test('a genuinely fresh thread (first dispatch ever, no prior record) starts at zero', () => {
  expect(resolveTokenBase('thread-A', null, null)).toEqual(zeroCounts())
})

test('a failed resume that falls back to a NEW thread starts at zero, not the old thread\'s total — seeding it would go negative', () => {
  const prior = tc(1_200_000)
  expect(resolveTokenBase('thread-B-fallback', 'thread-A', prior)).toEqual(zeroCounts())
})

test('a resume we intended but have no persisted total for yet starts at zero (no prior session ever folded)', () => {
  expect(resolveTokenBase('thread-A', 'thread-A', null)).toEqual(zeroCounts())
})
