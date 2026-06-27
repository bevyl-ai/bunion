import type { Config, Issue } from './types'

export interface GraphqlResult {
  body: unknown
  httpOk: boolean
  status: number
}

// Raw single-operation GraphQL against the configured Linear endpoint with the tracker auth. Used by the
// linear_graphql host tool AND by the orchestrator's reads below.
export async function graphql(cfg: Config, query: string, variables: Record<string, unknown>, token?: string | null): Promise<GraphqlResult> {
  const res = await fetch(cfg.tracker.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: (token ?? cfg.tracker.apiKey) ?? '' },
    body: JSON.stringify({ query, variables }),
  })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = { errors: [{ message: `linear: non-JSON response (${res.status})` }] }
  }
  return { body, httpOk: res.ok, status: res.status }
}

async function query<T>(cfg: Config, q: string, variables: Record<string, unknown>): Promise<T> {
  const r = await graphql(cfg, q, variables)
  if (!r.httpOk) throw new Error(`linear http ${r.status}`)
  const b = r.body as { data?: T; errors?: unknown }
  if (Array.isArray(b.errors) && b.errors.length > 0) throw new Error(`linear gql: ${JSON.stringify(b.errors)}`)
  if (b.data == null) throw new Error('linear gql: empty data')
  return b.data
}

interface RawIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  url: string
  priority: number
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  state: { name: string }
  labels: { nodes: { name: string }[] }
  inverseRelations: { nodes: { type: string; issue: { state: { name: string } | null } | null }[] }
  attachments: { nodes: { url: string }[] }
}

const ISSUE_FIELDS = `id identifier title description url priority createdAt startedAt completedAt
  state { name }
  labels { nodes { name } }
  inverseRelations { nodes { type issue { state { name } } } }
  attachments { nodes { url } }`

const CANDIDATES = `query Candidates($filter: IssueFilter) {
  issues(first: 100, filter: $filter) { nodes { ${ISSUE_FIELDS} } }
}`

const BY_IDS = `query ByIds($ids: [ID!]) {
  issues(first: 100, filter: { id: { in: $ids } }) { nodes { ${ISSUE_FIELDS} } }
}`

const BOARD = `query Board($filter: IssueFilter) {
  issues(first: 50, filter: $filter) { nodes { ${ISSUE_FIELDS} } }
}`

const BY_KEY = `query ByKey($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`

export async function fetchCandidates(cfg: Config): Promise<Issue[]> {
  // Scope by team and/or project + the active states. required_labels stay OUT of the query (Linear label matching
  // is case-sensitive) and are enforced host-side, case-insensitively, by the orchestrator's routability check.
  const filter: Record<string, unknown> = { state: { name: { in: cfg.tracker.activeStates } } }
  if (cfg.tracker.team) filter.team = { key: { eq: cfg.tracker.team } }
  if (cfg.tracker.projectSlug) filter.project = { slugId: { eq: cfg.tracker.projectSlug } }
  const d = await query<{ issues: { nodes: RawIssue[] } }>(cfg, CANDIDATES, { filter })
  return d.issues.nodes.map(toIssue)
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
  const d = await query<{ issues: { nodes: RawIssue[] } }>(cfg, BOARD, { filter })
  return d.issues.nodes.map(toIssue)
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
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    labels: r.labels.nodes.map((n) => n.name),
    blockers: r.inverseRelations.nodes.filter((n) => n.type === 'blocks').map((n) => ({ state: n.issue?.state?.name ?? null })),
    prUrl: r.attachments?.nodes.map((a) => a.url).find((u) => /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(u)) ?? null,
  }
}
