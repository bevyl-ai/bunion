import { describe, expect, test } from 'bun:test'
import { COMMENTS_TTL_MS, LinearStore } from './linear-store'
import type { Issue } from './types'

const issue = (id: string, identifier: string): Issue => ({
  id, identifier, title: 't', description: '', url: '', state: 'Todo', priority: 0, branchName: null,
  createdAt: '2026-07-01T00:00:00Z', updatedAt: null, startedAt: null, completedAt: null,
  labels: [], delegateId: null, blockers: [], prUrl: null,
})
const UUID = '11111111-2222-3333-4444-555555555555'

describe('LinearStore', () => {
  test('hydrates and looks up by id or identifier', () => {
    const s = new LinearStore()
    s.hydrateBoard([issue(UUID, 'BEV-1')])
    expect(s.getIssue(UUID)?.identifier).toBe('BEV-1')
    expect(s.getIssue('BEV-1')?.id).toBe(UUID)
    expect(s.getIssue('BEV-404')).toBeNull()
  })

  test('comments: null before set, served fresh, null after TTL', () => {
    const s = new LinearStore()
    expect(s.getComments(UUID)).toBeNull()
    s.setComments(UUID, [{ id: 'c1', body: 'hi', createdAt: '2026-07-01T00:00:00Z', author: 'a' }], 1000)
    expect(s.getComments(UUID, 1000 + COMMENTS_TTL_MS - 1)?.length).toBe(1)
    expect(s.getComments(UUID, 1000 + COMMENTS_TTL_MS + 1)).toBeNull()
  })

  test('commentCreate payload with the created comment appends in place', () => {
    const s = new LinearStore()
    s.setComments(UUID, [{ id: 'c1', body: 'first', createdAt: '2026-07-01T00:00:00Z', author: null }])
    s.applyMutation(
      'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id body createdAt } } }',
      { input: { issueId: UUID, body: 'second' } },
      { data: { commentCreate: { success: true, comment: { id: 'c2', body: 'second', createdAt: '2026-07-01T01:00:00Z' } } } },
    )
    expect(s.getComments(UUID)?.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  test('mutation without a comment payload invalidates that issue thread only', () => {
    const s = new LinearStore()
    const other = '99999999-8888-7777-6666-555555555555'
    s.setComments(UUID, [{ id: 'c1', body: 'x', createdAt: '2026-07-01T00:00:00Z', author: null }])
    s.setComments(other, [{ id: 'c9', body: 'y', createdAt: '2026-07-01T00:00:00Z', author: null }])
    s.applyMutation('mutation { commentCreate(input: { issueId: "' + UUID + '", body: "b" }) { success } }', {}, { data: { commentCreate: { success: true } } })
    expect(s.getComments(UUID)).toBeNull()
    expect(s.getComments(other)?.length).toBe(1)
  })

  test('mutation naming nothing recognizable clears all comment threads', () => {
    const s = new LinearStore()
    s.setComments(UUID, [{ id: 'c1', body: 'x', createdAt: '2026-07-01T00:00:00Z', author: null }])
    s.applyMutation('mutation { somethingGlobal { success } }', {}, { data: {} })
    expect(s.getComments(UUID)).toBeNull()
  })
})
