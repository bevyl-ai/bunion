import { describe, expect, test } from 'bun:test'
import { GithubMirror, type PrSnapshot } from './github-mirror'
import { gateFromSnapshot, parsePrUrl } from './github-sync'

const base: PrSnapshot = {
  repo: 'bevyl-ai/bevyl.ai', number: 1, state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  headRefOid: 'aaaa111122223333aaaa111122223333aaaa1111', updatedAt: '2026-07-02T00:00:00Z',
  checks: [], commits: [], reviews: [],
}
const HEAD = base.headRefOid
const stupify = (body: string, commitOid = HEAD) => ({ login: 'exe-dev-github-integration', body, submittedAt: '2026-07-02T00:00:00Z', commitOid })

describe('gateFromSnapshot — CI', () => {
  test('counts pass/fail/pending; failures carry names', () => {
    const g = gateFromSnapshot({ ...base, checks: [
      { name: 'CI', result: 'pass' }, { name: 'Deploy previews', result: 'fail' }, { name: 'Vercel', result: 'pending' },
    ] })
    expect(g.ci).toEqual({ pending: 1, failed: 1, passed: 1, failures: ['Deploy previews'], any: true })
  })
  test('no checks reported → any=false', () => {
    expect(gateFromSnapshot(base).ci.any).toBe(false)
  })
})

describe('gateFromSnapshot — stupify review matching', () => {
  test('marker covering head + ✅ approves', () => {
    const g = gateFromSnapshot({ ...base, reviews: [stupify(`nice, all fixed ✅\n<!-- stupify:${HEAD} -->`)] })
    expect(g.review.reviewed).toBe(true)
    expect(g.review.approved).toBe(true)
    expect(g.review.body).not.toContain('<!--') // marker stripped from the surfaced words
  })
  test('short (7-char) marker prefixes still cover', () => {
    const g = gateFromSnapshot({ ...base, reviews: [stupify(`✅ <!-- stupify:${HEAD.slice(0, 7)} -->`)] })
    expect(g.review.approved).toBe(true)
  })
  test('marker for an OLD commit does not cover the head', () => {
    const g = gateFromSnapshot({ ...base, reviews: [stupify('✅ <!-- stupify:bbbb222233334444bbbb222233334444bbbb2222 -->')] })
    expect(g.review.reviewed).toBe(false)
  })
  test('[skip ci] head: review of the newest CODE commit counts', () => {
    const code = 'cccc333344445555cccc333344445555cccc3333'
    const g = gateFromSnapshot({
      ...base,
      commits: [
        { oid: code, messageHeadline: 'fix: the actual change' },
        { oid: HEAD, messageHeadline: 'chore(pr): reset preview [skip ci]' },
      ],
      reviews: [stupify(`✅ <!-- stupify:${code} -->`, code)],
    })
    expect(g.review.approved).toBe(true)
    expect(g.review.codeSha).toBe(code)
  })
  test('objection (no ✅) on the head → reviewed but not approved', () => {
    const g = gateFromSnapshot({ ...base, reviews: [stupify(`same override trap is still here\n<!-- stupify:${HEAD} -->`)] })
    expect(g.review.reviewed).toBe(true)
    expect(g.review.approved).toBe(false)
    expect(g.review.body).toContain('override trap')
  })
  test('chronological last covering review wins (objection then fixed ✅)', () => {
    const g = gateFromSnapshot({ ...base, reviews: [
      stupify(`nope <!-- stupify:${HEAD} -->`),
      stupify(`all fixed ✅ <!-- stupify:${HEAD} -->`),
    ] })
    expect(g.review.approved).toBe(true)
  })
  test('non-stupify reviewers are ignored', () => {
    const g = gateFromSnapshot({ ...base, reviews: [{ login: 'Octember', body: `✅ <!-- stupify:${HEAD} -->`, submittedAt: '', commitOid: HEAD }] })
    expect(g.review.reviewed).toBe(false)
  })
})

describe('GithubMirror', () => {
  test('put/get roundtrip and stale listing', () => {
    const m = new GithubMirror(':memory:')
    m.put(base, 1000)
    expect(m.get(base.repo, base.number)?.snapshot.headRefOid).toBe(HEAD)
    expect(m.get('other/repo', 1)).toBeNull()
    expect(m.stale(500, 10, 2000).length).toBe(1) // 1000 < 2000-500
    expect(m.stale(1500, 10, 2000).length).toBe(0)
  })
})

describe('parsePrUrl', () => {
  test('extracts repo and number; rejects junk', () => {
    expect(parsePrUrl('https://github.com/bevyl-ai/bevyl.ai/pull/6694')).toEqual({ repo: 'bevyl-ai/bevyl.ai', number: 6694 })
    expect(parsePrUrl('https://linear.app/bevyl/issue/BEV-1')).toBeNull()
    expect(parsePrUrl(null)).toBeNull()
  })
})
