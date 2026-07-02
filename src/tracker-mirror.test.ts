import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMMENTS_STALE_MS, TrackerMirror } from './tracker-mirror'
import type { Issue } from './types'

const issue = (id: string, identifier: string, extra: Partial<Issue> = {}): Issue => ({
  id, identifier, title: 't', description: '', url: '', state: 'Todo', stateType: 'unstarted', priority: 0,
  branchName: null, createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z', startedAt: null,
  completedAt: null, labels: [], delegateId: null, project: null, blockers: [], prUrl: null, ...extra,
})
const UUID = '11111111-2222-3333-4444-555555555555'
const OTHER = '99999999-8888-7777-6666-555555555555'
const c1 = { id: 'c1', body: 'first', createdAt: '2026-07-01T00:00:00Z', author: null }

describe('TrackerMirror issues', () => {
  test('upserts and looks up by id or identifier; upsert replaces', () => {
    const m = new TrackerMirror(':memory:')
    m.upsertIssues([issue(UUID, 'BEV-1')])
    expect(m.getIssue(UUID)?.identifier).toBe('BEV-1')
    expect(m.getIssue('BEV-1')?.id).toBe(UUID)
    m.upsertIssues([issue(UUID, 'BEV-1', { state: 'Done', stateType: 'completed' })])
    expect(m.getIssue('BEV-1')?.state).toBe('Done')
    expect(m.issueCount()).toBe(1)
    expect(m.getIssue('BEV-404')).toBeNull()
  })

  test('persists across reopen', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mirror-')), 'mirror.db')
    const a = new TrackerMirror(path)
    a.upsertIssues([issue(UUID, 'BEV-1')])
    a.setMeta('issues_cursor', '2026-07-01T00:00:00Z')
    a.enqueueWrite('mutation { x }', {}, 'held write')
    a.close()
    const b = new TrackerMirror(path)
    expect(b.getIssue('BEV-1')?.id).toBe(UUID)
    expect(b.getMeta('issues_cursor')).toBe('2026-07-01T00:00:00Z')
    expect(b.pendingWrites()).toBe(1)
  })
})

describe('TrackerMirror comments', () => {
  test('null before hydration, served after, stale past the window', () => {
    const m = new TrackerMirror(':memory:')
    expect(m.getComments(UUID)).toBeNull()
    m.setComments(UUID, [c1], 1000)
    expect(m.getComments(UUID, 1000 + COMMENTS_STALE_MS - 1)?.length).toBe(1)
    expect(m.getComments(UUID, 1000 + COMMENTS_STALE_MS + 1)).toBeNull()
  })

  test('deltas land only in hydrated threads; touch resets the stale clock', () => {
    const m = new TrackerMirror(':memory:')
    m.setComments(UUID, [c1], 1000)
    m.applyCommentDeltas([
      { id: 'c2', body: 'delta', createdAt: '2026-07-01T01:00:00Z', author: 'x', issueId: UUID },
      { id: 'c9', body: 'orphan', createdAt: '2026-07-01T01:00:00Z', author: 'x', issueId: OTHER },
    ])
    m.touchCommentSync(2000)
    expect(m.getComments(UUID, 2000)?.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(m.getComments(OTHER, 2000)).toBeNull() // never hydrated — a partial thread must not masquerade as full
  })

  test('delta with an existing id edits in place', () => {
    const m = new TrackerMirror(':memory:')
    m.setComments(UUID, [c1])
    m.applyCommentDeltas([{ ...c1, body: 'edited', issueId: UUID }])
    expect(m.getComments(UUID)?.[0]?.body).toBe('edited')
  })
})

describe('TrackerMirror mutation write-back', () => {
  test('commentCreate payload with the comment appends in place', () => {
    const m = new TrackerMirror(':memory:')
    m.setComments(UUID, [c1])
    m.applyMutation(
      'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id body createdAt } } }',
      { input: { issueId: UUID, body: 'second' } },
      { data: { commentCreate: { success: true, comment: { id: 'c2', body: 'second', createdAt: '2026-07-01T01:00:00Z' } } } },
    )
    expect(m.getComments(UUID)?.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  test('mutation without a comment payload invalidates that thread only', () => {
    const m = new TrackerMirror(':memory:')
    m.setComments(UUID, [c1])
    m.setComments(OTHER, [{ ...c1, id: 'c9' }])
    m.applyMutation(`mutation { commentCreate(input: { issueId: "${UUID}", body: "b" }) { success } }`, {}, { data: { commentCreate: { success: true } } })
    expect(m.getComments(UUID)).toBeNull()
    expect(m.getComments(OTHER)?.length).toBe(1)
  })

  test('mutation naming nothing recognizable clears all threads', () => {
    const m = new TrackerMirror(':memory:')
    m.setComments(UUID, [c1])
    m.applyMutation('mutation { somethingGlobal { success } }', {}, { data: {} })
    expect(m.getComments(UUID)).toBeNull()
  })
})

describe('TrackerMirror write queue', () => {
  test('enqueue → due → complete', () => {
    const m = new TrackerMirror(':memory:')
    m.enqueueWrite('mutation { a }', { x: 1 }, 'move A')
    const due = m.dueWrites(10)
    expect(due.length).toBe(1)
    expect(due[0]!.variables).toEqual({ x: 1 })
    m.completeWrite(due[0]!.seq)
    expect(m.pendingWrites()).toBe(0)
  })

  test('failWrite backs off exponentially and keeps the write', () => {
    const m = new TrackerMirror(':memory:')
    m.enqueueWrite('mutation { a }', {}, 'flaky')
    const w = m.dueWrites(10)[0]!
    m.failWrite(w.seq, 1000)
    expect(m.dueWrites(10, 1000).length).toBe(0) // not due during backoff
    expect(m.dueWrites(10, 1000 + 30_001).length).toBe(1) // due after base backoff
    m.failWrite(w.seq, 2000)
    expect(m.dueWrites(10, 2000 + 30_001).length).toBe(0) // second failure doubled the delay
    expect(m.dueWrites(10, 2000 + 60_001).length).toBe(1)
    expect(m.pendingWrites()).toBe(1) // never dropped
  })
})
