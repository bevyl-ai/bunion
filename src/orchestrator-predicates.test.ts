import { expect, test } from 'bun:test'
import { dispatchBlocked, openBlockers } from './orchestrator-predicates'

test('dispatch blockers remain open until their Linear state type is completed or canceled', () => {
  const issue = {
    blockers: [
      { id: '1', identifier: 'BEV-1', state: 'In Progress', stateType: 'started' },
      { id: '2', identifier: 'BEV-2', state: 'Done', stateType: 'completed' },
      { id: '3', identifier: 'BEV-3', state: 'Canceled', stateType: 'canceled' },
    ],
  }
  expect(openBlockers(issue).map((b) => b.identifier)).toEqual(['BEV-1'])
  expect(dispatchBlocked(issue)).toBe(true)
})

test('dispatch blockers with missing state type are treated as open', () => {
  const issue = {
    blockers: [
      { id: '1', identifier: 'BEV-1', state: 'Done', stateType: null },
    ],
  }
  expect(openBlockers(issue).map((b) => b.identifier)).toEqual(['BEV-1'])
  expect(dispatchBlocked(issue)).toBe(true)
})

test('completed and canceled blockers do not block dispatch', () => {
  const issue = {
    blockers: [
      { id: '1', identifier: 'BEV-1', state: 'Done', stateType: 'completed' },
      { id: '2', identifier: 'BEV-2', state: 'Canceled', stateType: 'canceled' },
    ],
  }
  expect(openBlockers(issue)).toEqual([])
  expect(dispatchBlocked(issue)).toBe(false)
})
