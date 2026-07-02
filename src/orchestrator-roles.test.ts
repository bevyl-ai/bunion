import { expect, test } from 'bun:test'
import { renderBrainDigest, type PollHealth } from './orchestrator-roles'
import type { Issue } from './types'

const issue = (identifier: string, state: string): Issue => ({
  id: identifier.toLowerCase(),
  identifier,
  title: identifier,
  description: '',
  url: `https://linear.app/bevyl/issue/${identifier}`,
  state,
  stateType: 'started',
  priority: 4,
  branchName: null,
  createdAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
  startedAt: '2026-06-29T00:00:00.000Z',
  completedAt: null,
  labels: ['dark-factory'],
  delegateId: null,
  blockers: [],
  prUrl: null,
})

const render = (board: Issue[], poll: PollHealth = { failureStreak: 0, lastError: null, lastOkAt: 10_000 }) =>
  renderBrainDigest({
    board,
    paused: false,
    tokens: {},
    warnings: [],
    pollHealth: poll,
    pollIntervalMs: 30_000,
    nowMs: 10_000,
  })

test('brain digest drops an issue after it leaves Factory - Needs Engineer', () => {
  const before = render([
    issue('BEV-3960', 'Factory - Needs Engineer'),
    issue('BEV-3975', 'Factory - Needs Engineer'),
  ])
  expect(before).toContain('2 Factory - Needs Engineer (BEV-3960, BEV-3975)')

  const after = render([
    issue('BEV-3960', 'In Progress'),
    issue('BEV-3975', 'Factory - Needs Engineer'),
  ])
  expect(after).toContain('1 Factory - Needs Engineer (BEV-3975)')
  expect(after).not.toContain('BEV-3960')
})

test('brain digest marks board state unknown on poll failure instead of rendering stale counts', () => {
  const digest = render(
    [issue('BEV-3960', 'Factory - Needs Engineer')],
    { failureStreak: 1, lastError: 'ETIMEDOUT contacting api.linear.app', lastOkAt: 10_000 },
  )

  expect(digest).toContain('Stuck now: board state unknown/stale')
  expect(digest).toContain('last poll failed: ETIMEDOUT contacting api.linear.app')
  expect(digest).not.toContain('1 Factory - Needs Engineer (BEV-3960)')
})
