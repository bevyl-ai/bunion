import { CategorizedError, type Config, type Issue } from './types'

export interface GraphqlResult {
  body: unknown
  httpOk: boolean
  status: number
}

// Raw single-operation GraphQL against the configured Linear endpoint with the tracker auth. Used by the
// linear_graphql host tool AND by the orchestrator's reads below.
// §11.2: 30s network timeout so a hung Linear call never freezes the poll loop.
export async function graphql(cfg: Config, query: string, variables: Record<string, unknown>, token?: string | null): Promise<GraphqlResult> {
  let res: Response
  try {
    res = await fetch(cfg.tracker.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: (token ?? cfg.tracker.apiKey) ?? '' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    // §11.4: transport failure or timeout → linear_api_request
    const msg = err instanceof Error ? err.message : String(err)
    throw new CategorizedError('linear_api_request', `linear: request failed — ${msg}`)
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    // §11.4: a timeout/abort during body read is a transport failure, not a GraphQL error
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw new CategorizedError('linear_api_request', 'linear: request timed out during body read')
    body = { errors: [{ message: `linear: non-JSON response (${res.status})` }] }
  }
  return { body, httpOk: res.ok, status: res.status }
}

async function query<T>(cfg: Config, q: string, variables: Record<string, unknown>): Promise<T> {
  const r = await graphql(cfg, q, variables)
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
  state: { name: string }
  labels: { nodes: { name: string }[] }
  inverseRelations: { nodes: { type: string; issue: { id: string; identifier: string; state: { name: string } | null } | null }[] }
  attachments: { nodes: { url: string }[] }
}

const ISSUE_FIELDS = `id identifier title description url priority branchName createdAt updatedAt startedAt completedAt
  state { name }
  labels { nodes { name } }
  inverseRelations { nodes { type issue { id identifier state { name } } } }
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

// §11.2 PAGINATION: startup terminal cleanup can return many tickets.
const BY_STATES = (after: string | null) => `query ByStates($filter: IssueFilter${after != null ? ', $after: String' : ''}) {
  issues(first: 100, filter: $filter${after != null ? ', after: $after' : ''}) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`

type PagedIssues = { issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }

export async function fetchCandidates(cfg: Config): Promise<Issue[]> {
  // Scope by team and/or project + the active states. required_labels stay OUT of the query (Linear label matching
  // is case-sensitive) and are enforced host-side, case-insensitively, by the orchestrator's routability check.
  const filter: Record<string, unknown> = { state: { name: { in: cfg.tracker.activeStates } } }
  if (cfg.tracker.team) filter.team = { key: { eq: cfg.tracker.team } }
  if (cfg.tracker.projectSlug) filter.project = { slugId: { eq: cfg.tracker.projectSlug } }
  const nodes = await queryPaginated<RawIssue>(
    cfg,
    CANDIDATES,
    { filter },
    (d) => (d as PagedIssues).issues,
  )
  return nodes.map(toIssue)
}

// The board = every labeled ticket that's either active/handed-off OR recently merged (Done in the last day), so the
// dashboard can show the whole opt-in set plus a "Merged" column, but not the whole completed history. Canceled is
// excluded. Label filter is server-side (case-sensitive) for efficiency; the orchestrator re-filters host-side.
export async function fetchBoard(cfg: Config): Promise<Issue[]> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const filter: Record<string, unknown> = {
    state: { type: { neq: 'canceled' } },
    or: [{ completedAt: { null: true } }, { completedAt: { gt: cutoff } }],
  }
  if (cfg.tracker.team) filter.team = { key: { eq: cfg.tracker.team } }
  if (cfg.tracker.projectSlug) filter.project = { slugId: { eq: cfg.tracker.projectSlug } }
  if (cfg.tracker.requiredLabels.length) filter.labels = { name: { in: cfg.tracker.requiredLabels } }
  const nodes = await queryPaginated<RawIssue>(
    cfg,
    BOARD,
    { filter },
    (d) => (d as PagedIssues).issues,
  )
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

// Issues currently in any of the given workflow states, scoped to the configured team/project. Used at startup to
// find terminal-state tickets whose workspaces should be pruned (Symphony §8.6 startup cleanup / §11.1).
export async function fetchIssuesByStates(cfg: Config, stateNames: string[]): Promise<Issue[]> {
  if (stateNames.length === 0) return []
  const filter: Record<string, unknown> = { state: { name: { in: stateNames } } }
  if (cfg.tracker.team) filter.team = { key: { eq: cfg.tracker.team } }
  if (cfg.tracker.projectSlug) filter.project = { slugId: { eq: cfg.tracker.projectSlug } }
  const nodes = await queryPaginated<RawIssue>(
    cfg,
    BY_STATES,
    { filter },
    (d) => (d as PagedIssues).issues,
  )
  return nodes.map(toIssue)
}

// --- mutations + extra reads for dashboard action buttons ---

let stateCache: { key: string; map: Map<string, string> } | null = null
async function resolveStateId(cfg: Config, name: string): Promise<string | null> {
  const key = cfg.tracker.team ?? ''
  if (!stateCache || stateCache.key !== key) {
    const d = await query<{ teams: { nodes: { states: { nodes: { id: string; name: string }[] } }[] } }>(
      cfg,
      `query States($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { states { nodes { id name } } } } }`,
      { key },
    )
    const states = d.teams.nodes[0]?.states.nodes ?? []
    stateCache = { key, map: new Map(states.map((s) => [s.name.trim().toLowerCase(), s.id])) }
  }
  return stateCache.map.get(name.trim().toLowerCase()) ?? null
}

// Move an issue to a named workflow state — drives the dashboard's quick-action buttons. Throws on an unknown state.
export async function moveIssue(cfg: Config, issueId: string, stateName: string): Promise<void> {
  const sid = await resolveStateId(cfg, stateName)
  if (!sid) throw new Error(`unknown state: ${stateName}`)
  const r = await graphql(cfg, `mutation Move($id: String!, $s: String!) { issueUpdate(id: $id, input: { stateId: $s }) { success } }`, { id: issueId, s: sid })
  const b = r.body as { data?: { issueUpdate?: { success?: boolean } }; errors?: unknown }
  if (!r.httpOk || (Array.isArray(b.errors) && b.errors.length) || !b.data?.issueUpdate?.success) throw new Error(`move failed: ${JSON.stringify(b.errors ?? b.data)}`)
}

// Post a comment as the operator (the personal key) — the durable record for a dashboard directive.
export async function postComment(cfg: Config, issueId: string, body: string): Promise<void> {
  const r = await graphql(cfg, `mutation($i: String!, $b: String!) { commentCreate(input: { issueId: $i, body: $b }) { success } }`, { i: issueId, b: body })
  const d = r.body as { data?: { commentCreate?: { success?: boolean } }; errors?: unknown }
  if (!r.httpOk || (Array.isArray(d.errors) && d.errors.length) || !d.data?.commentCreate?.success) throw new Error(`comment failed: ${JSON.stringify(d.errors ?? d.data)}`)
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

// The reason to surface for a blocked ticket on the dashboard: ONLY the worker's own `Verdict:` line from its
// workpad. Never a human comment or other chatter — if there's no workpad verdict yet, show nothing.
export async function fetchLatestNote(cfg: Config, issueId: string): Promise<string | null> {
  const d = await query<{ issue: { comments: { nodes: { body: string }[] } } | null }>(
    cfg,
    `query Note($id: String!) { issue(id: $id) { comments(last: 8) { nodes { body } } } }`,
    { id: issueId },
  )
  const raw = (d.issue?.comments.nodes ?? []).map((n) => n.body).filter(Boolean)
  const workpad = raw.find((b) => /codex workpad/i.test(b))
  return workpad ? workpadReason(workpad) : null
}

function toIssue(r: RawIssue): Issue {
  return {
    id: r.id,
    identifier: r.identifier,
    title: r.title,
    description: r.description ?? '',
    url: r.url,
    state: r.state.name,
    priority: typeof r.priority === 'number' ? r.priority : 0,
    branchName: r.branchName ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt ?? null,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    labels: r.labels.nodes.map((n) => n.name.trim().toLowerCase()), // §4.1.1: labels normalized lowercase
    blockers: r.inverseRelations.nodes
      .filter((n) => n.type === 'blocks')
      .map((n) => ({ id: n.issue?.id ?? null, identifier: n.issue?.identifier ?? null, state: n.issue?.state?.name ?? null })),
    prUrl: r.attachments?.nodes.map((a) => a.url).find((u) => /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(u)) ?? null,
  }
}
