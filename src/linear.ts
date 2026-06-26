import type { Config } from './config'
import type { Issue, ResolvedStates } from './types'

const API = 'https://api.linear.app/graphql'

async function gql<T = unknown>(cfg: Config, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: cfg.linearApiKey },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`linear http ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { data?: T; errors?: unknown }
  if (Array.isArray(json.errors) && json.errors.length > 0) throw new Error(`linear gql: ${JSON.stringify(json.errors)}`)
  if (json.data == null) throw new Error('linear gql: empty data')
  return json.data
}

interface RawIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  url: string
  comments: { nodes: { body: string; createdAt: string }[] }
}

const ISSUE_FIELDS = `id identifier title description url comments(first: 50) { nodes { body createdAt } }`

const TEAM_STATES = `query States($key: String!) {
  teams(first: 1, filter: { key: { eq: $key } }) {
    nodes { id states(first: 100) { nodes { id name } } }
  }
}`

const BY_STATES = `query ByStates($team: String!, $states: [ID!]) {
  issues(first: 50, filter: { team: { key: { eq: $team } }, state: { id: { in: $states } } }) {
    nodes { ${ISSUE_FIELDS} sortOrder }
  }
}`

const BY_NUMBER = `query Issue($team: String!, $number: Float!) {
  issues(first: 1, filter: { team: { key: { eq: $team } }, number: { eq: $number } }) {
    nodes { ${ISSUE_FIELDS} }
  }
}`

const CURRENT_STATE = `query State($id: String!) { issue(id: $id) { state { id } } }`

const MOVE = `mutation Move($id: String!, $state: String!) {
  issueUpdate(id: $id, input: { stateId: $state }) { success }
}`

const COMMENT = `mutation Comment($id: String!, $body: String!) {
  commentCreate(input: { issueId: $id, body: $body }) { success }
}`

// Resolve the configured state NAMES to ids once, and fail loudly (listing the team's real states) if a name is
// wrong — a typo'd column name is the most likely setup mistake.
export async function resolveStates(cfg: Config): Promise<ResolvedStates> {
  const d = await gql<{ teams: { nodes: { states: { nodes: { id: string; name: string }[] } }[] } }>(cfg, TEAM_STATES, {
    key: cfg.linearTeam,
  })
  const team = d.teams.nodes[0]
  if (!team) throw new Error(`linear team '${cfg.linearTeam}' not found`)
  const byName = new Map(team.states.nodes.map((s) => [s.name, s.id]))
  const id = (name: string): string => {
    const v = byName.get(name)
    if (!v) throw new Error(`linear state '${name}' not found in team ${cfg.linearTeam}. available: ${[...byName.keys()].join(', ')}`)
    return v
  }
  return { ready: cfg.readyStates.map(id), working: id(cfg.workingState), review: id(cfg.reviewState), escalate: id(cfg.escalateState) }
}

// Tickets currently sitting in any of the given states, in board order (the column's manual sort = your priority).
export async function fetchByStates(cfg: Config, stateIds: string[]): Promise<Issue[]> {
  const d = await gql<{ issues: { nodes: (RawIssue & { sortOrder: number })[] } }>(cfg, BY_STATES, {
    team: cfg.linearTeam,
    states: stateIds,
  })
  return d.issues.nodes.sort((a, b) => a.sortOrder - b.sortOrder).map(toIssue)
}

export async function fetchIssue(cfg: Config, identifier: string): Promise<Issue> {
  const number = Number(identifier.split('-')[1])
  if (!Number.isFinite(number)) throw new Error(`bad identifier: ${identifier} (expected e.g. ${cfg.linearTeam}-123)`)
  const d = await gql<{ issues: { nodes: RawIssue[] } }>(cfg, BY_NUMBER, { team: cfg.linearTeam, number })
  const node = d.issues.nodes[0]
  if (!node) throw new Error(`issue ${identifier} not found in team ${cfg.linearTeam}`)
  return toIssue(node)
}

export async function currentStateId(cfg: Config, issueId: string): Promise<string | null> {
  const d = await gql<{ issue: { state: { id: string } } | null }>(cfg, CURRENT_STATE, { id: issueId })
  return d.issue?.state.id ?? null // null = deleted mid-run
}

export async function moveState(cfg: Config, issueId: string, stateId: string): Promise<void> {
  await gql(cfg, MOVE, { id: issueId, state: stateId })
}

// Bunion's own comments carry this marker so toIssue can drop them from the feedback fed back into a re-run — by
// body marker, NOT by author, so a personal API key (where bunion's Linear user IS you) doesn't filter out your own
// feedback comments. A human won't open a comment with this exact string.
const MARK = '🤖 bunion'

async function comment(cfg: Config, issueId: string, body: string): Promise<void> {
  await gql(cfg, COMMENT, { id: issueId, body })
}

// Post a marked bunion status comment, so it never loops back into a re-run prompt.
export async function postStatus(cfg: Config, issueId: string, body: string): Promise<void> {
  await comment(cfg, issueId, `${MARK} ${body}`)
}

function toIssue(r: RawIssue): Issue {
  return {
    id: r.id,
    identifier: r.identifier,
    title: r.title,
    description: r.description ?? '',
    url: r.url,
    // Newest human comments, rendered chronologically. Drop bunion's own (marked) status lines. The freshest review
    // note is the retry-with-feedback signal, so sort by recency — the API's default is oldest-first, which buries it.
    comments: r.comments.nodes
      .filter((n) => !n.body.startsWith(MARK))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10)
      .reverse()
      .map((n) => n.body),
  }
}
