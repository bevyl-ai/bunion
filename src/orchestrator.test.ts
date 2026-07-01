import { expect, test } from 'bun:test'
import { capClearIncrement, deadlockReason, pruneKeepByHost, resolveTokenBase } from './orchestrator'
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

// BEV re-audit (HIGH): a flat +hardTokenCap grant left a wildly-over-cap ticket just as capped as before — silently.
// These prove the fix: the grant always clears the current deficit, not just a fixed amount.
test('a ticket just barely over cap gets exactly one full cap worth of headroom', () => {
  // 201M total, 200M cap → 1M over → grant = 1M + 200M = 201M, new effective cap = 401M (well clear of 201M)
  expect(capClearIncrement(201_000_000, 200_000_000, 200_000_000)).toBe(201_000_000)
})

test('a wildly-over-cap ticket (the bug this fixes) gets a grant proportional to its real deficit', () => {
  // 6.3B total, 200M cap → 6.1B over → the old flat +200M would leave it just as capped; the fix clears it
  const inc = capClearIncrement(6_300_000_000, 200_000_000, 200_000_000)
  const newCap = 200_000_000 + inc
  expect(newCap).toBeGreaterThan(6_300_000_000) // genuinely unstuck, not just nominally bumped
})

test('a ticket with prior grants already folded into its cap still gets sized off the CURRENT effective cap, not the base', () => {
  // already granted once (cap=400M), now at 450M → 50M over → grant = 50M + 200M = 250M
  expect(capClearIncrement(450_000_000, 400_000_000, 200_000_000)).toBe(250_000_000)
})

// BEV-4061: the periodic VM workspace prune protected only TICKET workspaces — pool-role checkouts (role-mechanic
// etc.) were never on the keep list, so the sweep rm -rf'd them; a reused role workspace's top-level mtime goes
// stale even while codex works inside it, so a RUNNING mechanic's cwd could vanish under its shell commands. These
// prove role workspaces are now prune-protected exactly like tickets, under the exact dir key role-runner creates.
const HOSTS = ['vm-a', 'vm-b']

test('a role with a known host is kept there — under its literal role-<name> workspace dir key', () => {
  const keep = pruneKeepByHost(HOSTS, [], [], [{ name: 'mechanic', host: 'vm-a' }])
  expect(keep.get('vm-a')).toContain('role-mechanic') // the on-disk contract: must match role-runner's wsKey
  expect(keep.get('vm-b') ?? []).not.toContain('role-mechanic')
})

test('a role with NO host record (never dispatched, or its thread pre-dates host tracking) is kept on EVERY host', () => {
  const keep = pruneKeepByHost(HOSTS, [], [], [{ name: 'dreamer', host: null }])
  for (const h of HOSTS) expect(keep.get(h)).toContain('role-dreamer')
})

test('ticket protection is unchanged: pinned tickets kept on their worker only, host-unknown board tickets kept everywhere', () => {
  const keep = pruneKeepByHost(HOSTS, [{ identifier: 'BEV-1', host: 'vm-b' }], [{ identifier: 'BEV-2', host: null }], [])
  expect(keep.get('vm-b')).toContain('BEV-1')
  expect(keep.get('vm-a') ?? []).not.toContain('BEV-1')
  for (const h of HOSTS) expect(keep.get(h)).toContain('BEV-2')
})
