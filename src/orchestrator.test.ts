import { expect, test } from 'bun:test'
import { deadlockReason } from './orchestrator'

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
