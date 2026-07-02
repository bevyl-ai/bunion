import { expect, test } from 'bun:test'
import { baseBranchError } from './wait-tool'

test('default branch base passes the build gate assertion', () => {
  expect(baseBranchError('main', 'main')).toBeNull()
})

test('stacked PR base fails the build gate assertion', () => {
  expect(baseBranchError('bev-4095-dependency', 'main')).toContain('repository default branch is `main`')
})

test('missing base metadata fails closed', () => {
  expect(baseBranchError('', 'main')).toContain('metadata is missing')
})
