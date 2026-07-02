import { LinearDocument } from '@linear/sdk'
import type { StoredComment } from './tracker-mirror'
import { CategorizedError, type Config, type Issue } from './types'

export interface GraphqlResult {
  body: unknown
  httpOk: boolean
  status: number
}

// Global Linear request pacing + backpressure. EVERY request — the orchestrator's reads AND the agents' linear_graphql
// tool — funnels through graphql(), so one shared gate bounds our TOTAL request rate (min_request_gap_ms between
// requests), backs off HARD on a 429 rate-limit, and tracks 401s so the daemon can auto-pause before hammering a
// dead/blocked token into a revocation (exactly what got the OAuth app banned).
let nextSlot = 0
let cooldownUntil = 0
const authFailures: number[] = [] // ms timestamps of recent 401s
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function rateGate(minGapMs: number): Promise<void> {
  const gap = minGapMs > 0 ? minGapMs : 0
  const now = Date.now()
  const at = Math.max(now, nextSlot, cooldownUntil) // next free slot, honoring the min gap + any 429 cooldown
  nextSlot = at + gap
  if (at > now) await sleepMs(at - now)
}
// 401s in the last `windowMs` — the orchestrator polls this to AUTO-PAUSE when Linear auth keeps failing, so a dead
// token can't drive thousands of failed-auth retries (the pattern that gets an app revoked).
export function recentAuthFailures(windowMs = 60_000): number {
  const cut = Date.now() - windowMs
  while (authFailures.length > 0 && authFailures[0]! < cut) authFailures.shift()
  return authFailures.length
}

// The one transport function: every Linear request — reads, the typed mutations, the agents' linear_graphql escape
// hatch, and the durable write queue's drain — goes through here, so pacing (min_request_gap_ms), the 429 cooldown,
// the 401 breaker feed, and the body-level RATELIMITED detection all apply uniformly. §11.2: 30s timeout so a hung
// call never freezes the poll loop.
export async function graphql(cfg: Config, query: string, variables: Record<string, unknown>, token?: string | null): Promise<GraphqlResult> {
  await rateGate(cfg.tracker.minRequestGapMs)
  let res: Response
  try {
    res = await fetch(cfg.tracker.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: (token ?? cfg.tracker.appToken ?? cfg.tracker.apiKey) ?? '' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    // §11.4: transport failure or timeout → linear_api_request
    const msg = err instanceof Error ? err.message : String(err)
    throw new CategorizedError('linear_api_request', `linear: request failed — ${msg}`)
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'))
    cooldownUntil = Date.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000) // back off hard before the next request
  } else if (res.status === 401) {
    authFailures.push(Date.now()) // feed the auto-pause breaker
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    // §11.4: a timeout/abort during body read is a transport failure, not a GraphQL error
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw new CategorizedError('linear_api_request', 'linear: request timed out during body read')
    body = { errors: [{ message: `linear: non-JSON response (${res.status})` }] }
  }
  // Linear wraps hourly-quota rejections in HTTP **400** — the 429 only appears inside the error body
  // (extensions.code=RATELIMITED). Status-based backoff alone misses them, so the daemon kept firing at full pace,
  // burning the 2,500 req/h quota on requests that all failed (the 2026-07-02 death spiral). Cool down HARD off the
  // body we already parsed above (no second parse) — 5 min, since the quota window is an hour.
  if (isRateLimited(body)) cooldownUntil = Math.max(cooldownUntil, Date.now() + 5 * 60_000)
  return { body, httpOk: res.ok, status: res.status }
}

// True when a GraphQL error body carries Linear's RATELIMITED marker (extensions.code or extensions.type),
// whatever the outer HTTP status was.
export function isRateLimited(body: unknown): boolean {
  const errs = (body as { errors?: unknown })?.errors
  if (!Array.isArray(errs)) return false
  return errs.some((e) => {
    const ext = (e as { extensions?: { code?: unknown; type?: unknown } })?.extensions
    return ext?.code === 'RATELIMITED' || ext?.type === 'ratelimited'
  })
}

// Typed execution of the SDK's GENERATED documents (LinearDocument.*Document with their generated *Variables and
// result types), on OUR gated transport. The SDK doesn't export its TypedDocumentString wrapper, so the doc param
// is structural and the generics at each call site pin the schema contract. (The LinearClient model API was
// rejected: it lazy-loads relations — catastrophic for bulk sync — and silently ignores an injected fetch,
// bypassing the gate.)
async function execTyped<TData, TVars extends Record<string, unknown>>(cfg: Config, doc: { toString(): string }, variables: TVars, opts?: { retry: boolean }): Promise<TData> {
  return query<TData>(cfg, doc.toString(), variables, opts)
}

// Typed executor. READS retry transient server errors (Linear intermittently 5xxes heavy selections) — safe
// because they're idempotent. MUTATIONS pass { retry: false }: a 5xx after a comment landed would double-post;
// the durable write queue owns their retries instead.
const READ_RETRIES = [1_000, 3_000] // backoff before attempt 2 and 3
async function query<T>(cfg: Config, q: string, variables: Record<string, unknown>, opts: { retry: boolean } = { retry: true }): Promise<T> {
  let r = await graphql(cfg, q, variables)
  for (const backoff of opts.retry ? READ_RETRIES : []) {
    if (r.status < 500) break
    await sleepMs(backoff)
    r = await graphql(cfg, q, variables)
  }
  // §11.4: non-2xx HTTP → linear_api_status
  if (!r.httpOk) throw new CategorizedError('linear_api_status', `linear http ${r.status}`)
  const b = r.body as { data?: T; errors?: unknown }
  // §11.4: GraphQL-level errors → linear_graphql_errors
  if (Array.isArray(b.errors) && b.errors.length > 0) throw new CategorizedError('linear_graphql_errors', `linear gql: ${JSON.stringify(b.errors)}`)
  // §11.4: empty/missing data → linear_unknown_payload
  if (b.data == null) throw new CategorizedError('linear_unknown_payload', 'linear gql: empty data')
  return b.data
}

// §11.2 PAGINATION: loop on pageInfo.hasNextPage/endCursor, accumulate nodes across pages.
// Used by fetchCandidates, fetchBoard, fetchIssuesByStates — all of which are unbounded queries.
async function queryPaginated<N>(
  cfg: Config,
  buildQuery: (after: string | null) => string,
  variables: Record<string, unknown>,
  extract: (data: unknown) => { nodes: N[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } },
): Promise<N[]> {
  const all: N[] = []
  let cursor: string | null = null
  do {
    const q = buildQuery(cursor)
    const data = await query<unknown>(cfg, q, { ...variables, after: cursor })
    const page = extract(data)
    all.push(...page.nodes)
    if (!page.pageInfo.hasNextPage) break
    if (!page.pageInfo.endCursor) throw new CategorizedError('linear_missing_end_cursor', 'linear gql: hasNextPage=true but endCursor missing')
    cursor = page.pageInfo.endCursor
  } while (true)
  return all
}

interface RawIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  url: string
  priority: number
  branchName: string | null
  createdAt: string
  updatedAt: string | null
  startedAt: string | null
  completedAt: string | null
  state: { name: string; type: string }
  delegate: { id: string } | null
  labels: { nodes: { name: string }[] }
  inverseRelations: { nodes: { type: string; issue: { id: string; identifier: string; state: { name: string; type: string } | null } | null }[] }
  attachments: { nodes: { url: string }[] }
}

const ISSUE_FIELDS = `id identifier title description url priority branchName createdAt updatedAt startedAt completedAt
  state { name type }
  delegate { id }
  labels { nodes { name } }
  inverseRelations { nodes { type issue { id identifier state { name type } } } }
  attachments { nodes { url } }`

// §11.2 PAGINATION: each paginated query accepts $after and returns pageInfo.
const CANDIDATES = (after: string | null) => `query Candidates($filter: IssueFilter${after != null ? ', $after: String' : ''}) {
  issues(first: 100, filter: $filter${after != null ? ', after: $after' : ''}) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`

const BY_IDS = `query ByIds($ids: [ID!]) {
  issues(first: 100, filter: { id: { in: $ids } }) { nodes { ${ISSUE_FIELDS} } }
}`

// §11.2 PAGINATION: board is also unbounded when a team has many recent tickets.
const BOARD = (after: string | null) => `query Board($filter: IssueFilter${after != null ? ', $after: String' : ''}) {
  issues(first: 100, filter: $filter${after != null ? ', after: $after' : ''}) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`

const BY_KEY = `query ByKey($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`

type PagedIssues = { issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }

// Base scope every issue query shares: the configured team and/or project.
function scopeFilter(cfg: Config): LinearDocument.IssueFilter {
  const f: LinearDocument.IssueFilter = {}
  if (cfg.tracker.team) f.team = { key: { eq: cfg.tracker.team } }
  if (cfg.tracker.projectSlug) f.project = { slugId: { eq: cfg.tracker.projectSlug } }
  return f
}

export async function fetchCandidates(cfg: Config): Promise<Issue[]> {
  // Scope by team and/or project + the active states. required_labels stay OUT of the query (Linear label matching
  // is case-sensitive) and are enforced host-side, case-insensitively, by the orchestrator's routability check.
  const filter: LinearDocument.IssueFilter = { ...scopeFilter(cfg), state: { name: { in: cfg.tracker.activeStates } } }
  const nodes = await queryPaginated<RawIssue>(cfg, CANDIDATES, { filter }, (d) => (d as PagedIssues).issues)
  return nodes.map(toIssue)
}

// The board = every labeled ticket that's either active/handed-off OR recently merged (Done in the last day), so the
// dashboard can show the whole opt-in set plus a "Merged" column, but not the whole completed history. Canceled is
// excluded. Label filter is server-side (case-sensitive) for efficiency; the orchestrator re-filters host-side.
export async function fetchBoard(cfg: Config): Promise<Issue[]> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const filter: LinearDocument.IssueFilter = {
    ...scopeFilter(cfg),
    state: { type: { neq: 'canceled' } },
    or: [{ completedAt: { null: true } }, { completedAt: { gt: cutoff } }],
  }
  // Opt-in gate (label OR delegated-to-app), nested under `and` so it doesn't collide with the completedAt `or` above.
  // A loose server-side superset — case-sensitive label match + delegate — narrowed authoritatively host-side by isRoutable.
  const optIn: LinearDocument.IssueFilter[] = []
  if (cfg.tracker.requiredLabels.length) optIn.push({ labels: { name: { in: cfg.tracker.requiredLabels } } })
  if (cfg.tracker.appActorId) optIn.push({ delegate: { id: { eq: cfg.tracker.appActorId } } })
  if (optIn.length) filter.and = [{ or: optIn }]
  const nodes = await queryPaginated<RawIssue>(cfg, BOARD, { filter }, (d) => (d as PagedIssues).issues)
  return nodes.map(toIssue)
}

export async function fetchStatesByIds(cfg: Config, ids: string[]): Promise<Issue[]> {
  if (ids.length === 0) return []
  const d = await query<{ issues: { nodes: RawIssue[] } }>(cfg, BY_IDS, { ids })
  return d.issues.nodes.map(toIssue)
}

// Fetch a single issue by its key (e.g. BEV-123) or internal id — Linear's `issue(id:)` accepts both.
export async function fetchById(cfg: Config, key: string): Promise<Issue> {
  const d = await query<{ issue: RawIssue | null }>(cfg, BY_KEY, { id: key })
  if (!d.issue) throw new Error(`issue ${key} not found`)
  return toIssue(d.issue)
}

// --- mutations + extra reads for dashboard action buttons (generated typed documents on the gated transport) ---

let stateCache: { key: string; map: Map<string, string> } | null = null
async function resolveStateId(cfg: Config, name: string): Promise<string | null> {
  const key = cfg.tracker.team ?? ''
  if (!stateCache || stateCache.key !== key) {
    const d = await execTyped<LinearDocument.WorkflowStatesQuery, LinearDocument.WorkflowStatesQueryVariables>(cfg, LinearDocument.WorkflowStatesDocument, { filter: { team: { key: { eq: key } } }, first: 100 })
    stateCache = { key, map: new Map(d.workflowStates.nodes.map((s) => [s.name.trim().toLowerCase(), s.id])) }
  }
  return stateCache.map.get(name.trim().toLowerCase()) ?? null
}

// A durable-write sink (the TrackerMirror's queue) — moveIssue/postComment enqueue there instead of throwing away
// the write when Linear rejects it (rate limit, blip). Typed structurally to keep this module free of a mirror import.
export interface WriteQueue {
  enqueueWrite(query: string, variables: Record<string, unknown>, note?: string): void
}

// Move an issue to a named workflow state — drives the dashboard's quick-action buttons and the deadlock sweep.
// With a queue: a failed move is ENQUEUED for durable retry instead of thrown away (a lost state transition is how
// merged tickets sat in Needs Engineer for days). Without one (or on an unknown state): throws as before.
// The queue payload is the printed generated document + the same typed variables, so the drain replays exactly
// what would have run.
export async function moveIssue(cfg: Config, issueId: string, stateName: string, queue?: WriteQueue): Promise<void> {
  const sid = await resolveStateId(cfg, stateName)
  if (!sid) throw new Error(`unknown state: ${stateName}`)
  const variables: LinearDocument.UpdateIssueMutationVariables = { id: issueId, input: { stateId: sid } }
  try {
    const d = await execTyped<LinearDocument.UpdateIssueMutation, LinearDocument.UpdateIssueMutationVariables>(cfg, LinearDocument.UpdateIssueDocument, variables, { retry: false })
    if (!d.issueUpdate.success) throw new Error('issueUpdate returned success=false')
  } catch (e) {
    if (queue) return queue.enqueueWrite(LinearDocument.UpdateIssueDocument.toString(), variables, `move ${issueId} → ${stateName}`)
    throw new Error(`move failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// Post a comment as the factory — the durable record for a dashboard directive. Same queue semantics as moveIssue.
export async function postComment(cfg: Config, issueId: string, body: string, queue?: WriteQueue): Promise<void> {
  const variables: LinearDocument.CreateCommentMutationVariables = { input: { issueId, body } }
  try {
    const d = await execTyped<LinearDocument.CreateCommentMutation, LinearDocument.CreateCommentMutationVariables>(cfg, LinearDocument.CreateCommentDocument, variables, { retry: false })
    if (!d.commentCreate.success) throw new Error('commentCreate returned success=false')
  } catch (e) {
    if (queue) return queue.enqueueWrite(LinearDocument.CreateCommentDocument.toString(), variables, `comment on ${issueId}`)
    throw new Error(`comment failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const cleanMd = (b: string): string =>
  b
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their text
    .replace(/[`*_>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

// Pull the operator-facing reason a worker recorded in its `## Codex Workpad` — the `Verdict:`/`Dashboard:` line it
// writes on a handoff (e.g. "Verdict: BLOCKED — <why a human is needed>").
function workpadReason(workpad: string): string | null {
  const lines = workpad.split('\n')
  for (const ln of lines) {
    const m = ln.match(/\bverdict\b\s*[:\-—]?\s*\*{0,2}\s*(?:blocked|failed|pass(?:ed)?|verified|unblocked|needs?\s*human|working)?\s*\*{0,2}\s*[.\-—:]*\s*(.+)/i)
    if (m?.[1] && m[1].replace(/[*\s]/g, '').length > 4) return cleanMd(m[1])
  }
  for (const ln of lines) {
    const m = ln.match(/(?:dashboard(?: note)?|reason|blocked because|human must|needs?(?: a)? human)\s*[:\-—]\s*(.+)/i)
    if (m?.[1] && m[1].trim().length > 4) return cleanMd(m[1])
  }
  return null
}

// Pure extraction shared by the fetchers below and the mirror-first readers (the orchestrator serves notes and
// workpads from the TrackerMirror's hydrated threads without an API call when it can).
export function noteFromComments(bodies: string[]): string | null {
  const workpad = workpadFromComments(bodies)
  return workpad ? workpadReason(workpad) : null
}

export function workpadFromComments(bodies: string[]): string | null {
  return bodies.filter(Boolean).find((b) => /codex workpad/i.test(b)) ?? null
}

// The agent's persistent `## Codex Workpad` comment (full body) — folded into the dispatch prompt so a fresh phase
// starts with its prior notes WITHOUT the agent spending turns + Linear reads pulling them back.
// Window note (BEV ergonomics audit): the workpad is ONE comment edited in place over a ticket's life, but Linear's
// `comments(last: N)` orders by CREATION time — repeated auto-block comments push the (old) workpad out of a narrow
// window even though its content was just updated (the BEV-3869 no-note failure). 40 is well past any real ticket's
// system-comment count.
export async function fetchWorkpad(cfg: Config, issueId: string): Promise<string | null> {
  const d = await query<{ issue: { comments: { nodes: { body: string }[] } } | null }>(
    cfg,
    `query Workpad($id: String!) { issue(id: $id) { comments(last: 40) { nodes { body } } } }`,
    { id: issueId },
  )
  return workpadFromComments((d.issue?.comments.nodes ?? []).map((n) => n.body))
}

// The dashboard's blocked-ticket reason: ONLY the worker's own `Verdict:` line from its workpad — never a human
// comment or other chatter. Same fetch as the workpad; different extraction.
export async function fetchLatestNote(cfg: Config, issueId: string): Promise<string | null> {
  const workpad = await fetchWorkpad(cfg, issueId)
  return workpad ? workpadReason(workpad) : null
}

// Full comment thread for the TrackerMirror — fetched ONCE per ticket by linear_read, then kept current in the
// mirror by applying mutation payloads (see tracker-mirror.ts). This is the read that used to happen every agent turn.
export async function fetchIssueComments(cfg: Config, issueId: string): Promise<StoredComment[]> {
  const d = await query<{ issue: { comments: { nodes: { id: string; body: string; createdAt: string; user: { displayName: string } | null; botActor: { name: string } | null }[] } } | null }>(
    cfg,
    `query Thread($id: String!) { issue(id: $id) { comments(last: 100) { nodes { id body createdAt user { displayName } botActor { name } } } } }`,
    { id: issueId },
  )
  return (d.issue?.comments.nodes ?? []).map((n) => ({ id: n.id, body: n.body, createdAt: n.createdAt, author: n.user?.displayName ?? n.botActor?.name ?? null }))
}

// ── delta fetchers for the tracker mirror (tracker-sync.ts) ─────────────────────────────────────────────────────

// §11.2 PAGINATION: initial mirror hydration can span many pages.
const SYNC_ISSUES = (after: string | null) => `query Sync($filter: IssueFilter${after != null ? ', $after: String' : ''}) {
  issues(first: 100, filter: $filter${after != null ? ', after: $after' : ''}) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`

// Initial mirror scope: everything not-yet-completed (whole live backlog) plus anything touched in the trailing
// window (recent history for the dashboard/triage). Canceled is excluded — the mirror is operational, not archival.
export async function fetchInitialIssues(cfg: Config, sinceISO: string): Promise<Issue[]> {
  const filter: LinearDocument.IssueFilter = {
    ...scopeFilter(cfg),
    state: { type: { neq: 'canceled' } },
    or: [{ completedAt: { null: true } }, { updatedAt: { gt: sinceISO } }],
  }
  const nodes = await queryPaginated<RawIssue>(cfg, SYNC_ISSUES, { filter }, (d) => (d as PagedIssues).issues)
  return nodes.map(toIssue)
}

// Issues touched at/after the cursor — the steady-state poll. gte (not gt) so boundary ties are re-fetched rather
// than missed; upserts are idempotent, so the overlap costs nothing.
export async function fetchIssuesUpdatedSince(cfg: Config, cursorISO: string): Promise<Issue[]> {
  const filter: LinearDocument.IssueFilter = { ...scopeFilter(cfg), updatedAt: { gte: cursorISO } }
  const nodes = await queryPaginated<RawIssue>(cfg, SYNC_ISSUES, { filter }, (d) => (d as PagedIssues).issues)
  return nodes.map(toIssue)
}

// Comment deltas across the whole team — one request keeps every hydrated thread in the mirror current, which is
// what lets agents read threads at zero API cost between writes.
const COMMENT_DELTAS = (after: string | null) => `query CommentDeltas($filter: CommentFilter${after != null ? ', $after: String' : ''}) {
  comments(first: 100, filter: $filter${after != null ? ', after: $after' : ''}) {
    nodes { id body createdAt updatedAt user { displayName } botActor { name } issue { id } }
    pageInfo { hasNextPage endCursor }
  }
}`

type RawCommentDelta = { id: string; body: string; createdAt: string; updatedAt: string; user: { displayName: string } | null; botActor: { name: string } | null; issue: { id: string } | null }

export async function fetchCommentsUpdatedSince(cfg: Config, cursorISO: string): Promise<(StoredComment & { issueId: string; updatedAt: string })[]> {
  const filter: LinearDocument.CommentFilter = { updatedAt: { gte: cursorISO } }
  if (cfg.tracker.team) filter.issue = { team: { key: { eq: cfg.tracker.team } } }
  const nodes = await queryPaginated<RawCommentDelta>(cfg, COMMENT_DELTAS, { filter }, (d) => (d as { comments: { nodes: RawCommentDelta[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }).comments)
  return nodes
    .filter((n) => n.issue != null)
    .map((n) => ({ id: n.id, body: n.body, createdAt: n.createdAt, updatedAt: n.updatedAt, author: n.user?.displayName ?? n.botActor?.name ?? null, issueId: n.issue!.id }))
}

function toIssue(r: RawIssue): Issue {
  return {
    id: r.id,
    identifier: r.identifier,
    title: r.title,
    description: r.description ?? '',
    url: r.url,
    state: r.state.name,
    stateType: r.state.type ?? '',
    priority: typeof r.priority === 'number' ? r.priority : 0,
    branchName: r.branchName ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt ?? null,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    labels: r.labels.nodes.map((n) => n.name.trim().toLowerCase()), // §4.1.1: labels normalized lowercase
    delegateId: r.delegate?.id ?? null,
    blockers: r.inverseRelations.nodes
      .filter((n) => n.type === 'blocks')
      .map((n) => ({ id: n.issue?.id ?? null, identifier: n.issue?.identifier ?? null, state: n.issue?.state?.name ?? null, stateType: n.issue?.state?.type ?? null })),
    prUrl: r.attachments?.nodes.map((a) => a.url).find((u) => /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(u)) ?? null,
  }
}
