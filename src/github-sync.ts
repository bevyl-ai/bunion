import { GraphqlResponseError, graphql as octokitGraphql } from '@octokit/graphql'
import { githubAppToken } from './github'
import type { GithubMirror, PrCheck, PrSnapshot } from './github-mirror'
import type { Config, Issue } from './types'

// IO + domain logic for the GitHub mirror: fetch a PR snapshot with the factory's own app token (one GraphQL
// request replaces the per-VM `gh pr checks` + `gh pr view` polling loops), and compute the build-gate verdict
// as a pure function every consumer shares — the wait-tool live, and later the reconciliation sweep.

const PR_QUERY = `query Pr($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state mergeable mergeStateStatus headRefOid updatedAt
      commits(last: 25) { nodes { commit { oid messageHeadline } } }
      lastCommit: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 60) {
        nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } }
      } } } } }
      reviews(last: 40) { nodes { author { login } body submittedAt commit { oid } } }
    }
  }
}`

// Classifies a caught fetchPrSnapshot failure. Pulled out as a pure function — and given its own unit tests below —
// because the classification is easy to get backwards: GitHub returns the SAME error type (NOT_FOUND) whether the
// repo is unresolvable (no app installation — the Octember case) or the repo resolved fine and only the PR number
// is bad; type alone can't tell them apart. The error PATH does: a repo-level failure is `["repository"]` (length
// 1), a PR-level failure is `["repository","pullRequest"]` (length 2). Verified live against both real shapes
// before trusting this (an earlier version checked type alone and misrouted every uninstalled-repo PR to a hard
// 'not_found' failure instead of the intended VM-gate fallback).
export function classifyPrFetchFailure(e: unknown): 'no_access' | 'not_found' | 'rethrow' {
  if (e instanceof GraphqlResponseError) {
    const err = e.errors?.[0]
    if (err?.type === 'NOT_FOUND') return err.path.length <= 1 ? 'no_access' : 'not_found'
    return 'no_access' // any other GraphQL-level error (permission/scope) — let the caller fall back
  }
  const status = (e as { status?: number }).status
  return status === 401 || status === 403 ? 'no_access' : 'rethrow'
}

// One normalized snapshot from GitHub, or a categorized failure the caller can act on: 'no_access' → the app is
// not installed on this repo (e.g. the Octember org) and the wait-tool must use its legacy VM-side gate.
export async function fetchPrSnapshot(cfg: Config, repo: string, number: number): Promise<PrSnapshot | 'no_access' | 'not_found'> {
  const token = await githubAppToken(cfg)
  if (!token) return 'no_access'
  const [owner, name] = repo.split('/') as [string, string]
  try {
    const data = await octokitGraphql<{ repository: { pullRequest: RawPr | null } | null }>(PR_QUERY, {
      owner,
      name,
      number,
      headers: { authorization: `bearer ${token}` },
      request: { signal: AbortSignal.timeout(30_000) },
    })
    const pr = data.repository?.pullRequest
    return pr ? normalizePr(repo, number, pr) : 'not_found'
  } catch (e) {
    const verdict = classifyPrFetchFailure(e)
    if (verdict === 'rethrow') throw e
    return verdict
  }
}

// Refresh-through-the-mirror with per-PR debounce: serves the stored snapshot when it is younger than minAgeMs,
// otherwise fetches and stores. Concurrent waiters on one PR therefore cost one request per window, not one each.
export async function refreshPr(cfg: Config, mirror: GithubMirror, repo: string, number: number, minAgeMs: number): Promise<PrSnapshot | 'no_access' | 'not_found'> {
  const cached = mirror.get(repo, number)
  if (cached && Date.now() - cached.fetchedAt < minAgeMs) return cached.snapshot
  const fresh = await fetchPrSnapshot(cfg, repo, number)
  if (typeof fresh !== 'string') mirror.put(fresh)
  return fresh
}

// Passive sweep, called each poll tick: keep board-attached PR snapshots from rotting so pit-freshness reads are
// honest. Newly seen board PRs are seeded lazily (first refresh stores them); errors are per-PR and non-fatal.
const SWEEP_STALE_MS = 5 * 60_000
const SWEEP_BATCH = 6

export async function sweepBoardPrs(cfg: Config, mirror: GithubMirror, board: Issue[], warn: (msg: string) => void): Promise<void> {
  if (!cfg.github) return
  const seen = new Set(mirror.tracked().map((p) => `${p.repo}#${p.number}`))
  const wanted: { repo: string; number: number }[] = []
  for (const i of board) {
    const parsed = parsePrUrl(i.prUrl)
    if (parsed && !seen.has(`${parsed.repo}#${parsed.number}`)) wanted.push(parsed)
  }
  const due = [...wanted, ...mirror.stale(SWEEP_STALE_MS, SWEEP_BATCH)].slice(0, SWEEP_BATCH)
  for (const p of due) {
    try {
      await refreshPr(cfg, mirror, p.repo, p.number, SWEEP_STALE_MS)
    } catch (e) {
      warn(`github mirror: refresh ${p.repo}#${p.number} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

export function parsePrUrl(url: string | null): { repo: string; number: number } | null {
  const m = url?.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
  return m ? { repo: m[1]!, number: Number(m[2]!) } : null
}

// ── the build gate, as a pure function over a snapshot ──────────────────────────────────────────────────────────
// Same semantics the wait-tool's VM-side parsing had: CI fails on any failed context; the stupify review must carry
// a marker covering the latest CODE commit (head, or the newest non-[skip ci]/reset commit) and a ✅ to approve.

export const STUPIFY_LOGIN = 'exe-dev-github-integration'

// Named (not inline) so both gate implementations — this mirror-backed one and wait-tool's legacy VM-side `gh`
// parsing — share one shape instead of two structurally-identical definitions silently drifting apart.
export interface CiState {
  pending: number
  failed: number
  passed: number
  failures: string[]
  any: boolean
}

export interface ReviewState {
  reviewed: boolean
  approved: boolean
  body: string
  sha: string
  head: string
  codeSha: string
}

export interface GateState {
  ci: CiState
  review: ReviewState
}

export function gateFromSnapshot(snap: PrSnapshot): GateState {
  let pending = 0, failed = 0, passed = 0
  const failures: string[] = []
  for (const c of snap.checks) {
    if (c.result === 'pass') passed++
    else if (c.result === 'fail') { failed++; failures.push(c.name) }
    else pending++
  }
  const head = snap.headRefOid
  let codeSha = head
  for (let i = snap.commits.length - 1; i >= 0; i--) {
    if (!/\[skip ci\]|chore\(pr\):\s*reset/i.test(snap.commits[i]!.messageHeadline)) {
      codeSha = snap.commits[i]!.oid
      break
    }
  }
  const covers = (sha: string): boolean => !!sha && (sha === head || sha === codeSha || head.startsWith(sha) || codeSha.startsWith(sha))
  let cover: { body: string; sha: string } | null = null
  for (const r of snap.reviews) {
    if (!r.login.includes(STUPIFY_LOGIN)) continue
    const sha = (r.body.match(/stupify:([0-9a-f]{7,40})/) || [])[1] || ''
    if (covers(sha)) cover = { body: r.body, sha } // chronological → last match wins (latest review of the head code)
  }
  const review = cover
    ? { reviewed: true, approved: cover.body.includes('✅'), body: cover.body.replace(/<!--[\s\S]*?-->/g, '').trim(), sha: cover.sha, head, codeSha }
    : { reviewed: false, approved: false, body: '', sha: '', head, codeSha }
  return { ci: { pending, failed, passed, failures, any: pending + failed + passed > 0 }, review }
}

// ── normalization ────────────────────────────────────────────────────────────────────────────────────────────────

interface RawPr {
  state: string
  mergeable: string | null
  mergeStateStatus: string | null
  headRefOid: string
  updatedAt: string
  commits: { nodes: { commit: { oid: string; messageHeadline: string } }[] }
  lastCommit: { nodes: { commit: { statusCheckRollup: { state: string; contexts: { nodes: RawContext[] } } | null } }[] }
  reviews: { nodes: { author: { login: string } | null; body: string; submittedAt: string; commit: { oid: string } | null }[] }
}

type RawContext =
  | { __typename: 'CheckRun'; name: string; status: string; conclusion: string | null }
  | { __typename: 'StatusContext'; context: string; state: string }

function normalizePr(repo: string, number: number, pr: RawPr): PrSnapshot {
  const checks: PrCheck[] = []
  for (const c of pr.lastCommit.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []) {
    const mapped = c.__typename === 'CheckRun' ? mapCheckRun(c) : mapStatusContext(c)
    if (mapped) checks.push(mapped)
  }
  return {
    repo,
    number,
    state: pr.state as PrSnapshot['state'],
    mergeable: pr.mergeable ?? 'UNKNOWN',
    mergeStateStatus: pr.mergeStateStatus ?? 'UNKNOWN',
    headRefOid: pr.headRefOid,
    updatedAt: pr.updatedAt,
    checks,
    commits: pr.commits.nodes.map((n) => ({ oid: n.commit.oid, messageHeadline: n.commit.messageHeadline })),
    reviews: pr.reviews.nodes.map((n) => ({ login: n.author?.login ?? '', body: n.body, submittedAt: n.submittedAt, commitOid: n.commit?.oid ?? '' })),
  }
}

function mapCheckRun(c: { name: string; status: string; conclusion: string | null }): PrCheck | null {
  if (c.status !== 'COMPLETED') return { name: c.name, result: 'pending' }
  switch (c.conclusion) {
    case 'SUCCESS': return { name: c.name, result: 'pass' }
    case 'NEUTRAL': case 'SKIPPED': return null // same as the old `gh pr checks` parsing: ignored
    default: return { name: c.name, result: 'fail' } // FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE
  }
}

function mapStatusContext(c: { context: string; state: string }): PrCheck | null {
  switch (c.state) {
    case 'SUCCESS': return { name: c.context, result: 'pass' }
    case 'PENDING': case 'EXPECTED': return { name: c.context, result: 'pending' }
    default: return { name: c.context, result: 'fail' } // FAILURE, ERROR
  }
}
