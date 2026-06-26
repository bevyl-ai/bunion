import type { Config } from './config'
import type { Issue, IssueState } from './types'

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

interface RawRelation {
  type: string
  issue: { state: { type: string } } // the source of an inverse relation = the potential blocker
}

interface RawIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  estimate: number | null
  url: string
  priority: number
  createdAt: string
  labels: { nodes: { name: string }[] }
  inverseRelations: { nodes: RawRelation[] }
}

const ISSUE_FIELDS = `id identifier title description estimate url priority createdAt
  labels { nodes { name } }
  inverseRelations { nodes { type issue { state { type } } } }`

const CANDIDATES = `query Candidates($team: String!, $label: String!) {
  issues(first: 50, filter: {
    team: { key: { eq: $team } },
    labels: { name: { eq: $label } },
    state: { type: { eq: "unstarted" } }
  }) { nodes { ${ISSUE_FIELDS} } }
}`

const BY_NUMBER = `query Issue($team: String!, $number: Float!) {
  issues(first: 1, filter: { team: { key: { eq: $team } }, number: { eq: $number } }) {
    nodes { ${ISSUE_FIELDS} }
  }
}`

const STATE = `query State($id: String!) { issue(id: $id) { state { type } } }`

const COMMENT = `mutation Comment($id: String!, $body: String!) {
  commentCreate(input: { issueId: $id, body: $body }) { success }
}`

export async function fetchCandidates(cfg: Config): Promise<Issue[]> {
  const d = await gql<{ issues: { nodes: RawIssue[] } }>(cfg, CANDIDATES, { team: cfg.linearTeam, label: cfg.label })
  return d.issues.nodes.map(toIssue).sort(byDispatchOrder)
}

export async function fetchIssue(cfg: Config, identifier: string): Promise<Issue> {
  const number = Number(identifier.split('-')[1])
  if (!Number.isFinite(number)) throw new Error(`bad identifier: ${identifier} (expected e.g. ${cfg.linearTeam}-123)`)
  const d = await gql<{ issues: { nodes: RawIssue[] } }>(cfg, BY_NUMBER, { team: cfg.linearTeam, number })
  const node = d.issues.nodes[0]
  if (!node) throw new Error(`issue ${identifier} not found in team ${cfg.linearTeam}`)
  return toIssue(node)
}

// Re-read just the workflow state of an in-flight ticket so the runner can bail before opening a PR on something a
// human cancelled or resolved mid-run.
export async function currentState(cfg: Config, issueId: string): Promise<IssueState> {
  const d = await gql<{ issue: { state: { type: string } } | null }>(cfg, STATE, { id: issueId })
  if (d.issue == null) return 'canceled' // deleted mid-run — treat as gone so the runner bails without a PR
  return mapState(d.issue.state.type)
}

export async function comment(cfg: Config, issueId: string, body: string): Promise<void> {
  await gql(cfg, COMMENT, { id: issueId, body })
}

function toIssue(r: RawIssue): Issue {
  const labels = r.labels.nodes.map((n) => n.name)
  return {
    id: r.id,
    identifier: r.identifier,
    title: r.title,
    description: r.description ?? '',
    estimate: r.estimate,
    url: r.url,
    priority: r.priority,
    createdAt: r.createdAt,
    labels,
    component: componentOf(labels),
    blocked: r.inverseRelations.nodes.some((n) => n.type === 'blocks' && !isTerminal(n.issue.state.type)),
  }
}

// Symphony §8.2 dispatch order: priority (urgent→low, no-priority last), then oldest first, then identifier.
function byDispatchOrder(a: Issue, b: Issue): number {
  return rank(a.priority) - rank(b.priority) || a.createdAt.localeCompare(b.createdAt) || a.identifier.localeCompare(b.identifier)
}

function rank(priority: number): number {
  return priority === 0 ? 5 : priority // Linear: 0=none(last), 1=urgent … 4=low
}

// The factory gates on a declared scope, not an inferred one: the `area:<x>` label IS the component.
function componentOf(labels: string[]): string | null {
  const area = labels.find((l) => l.startsWith('area:') || l.startsWith('area/'))
  if (!area) return null
  return area.split(/[:/]/, 2)[1] || null
}

function isTerminal(stateType: string): boolean {
  return stateType === 'completed' || stateType === 'canceled'
}

function mapState(type: string): IssueState {
  switch (type) {
    case 'triage': return 'triage'
    case 'unstarted': return 'todo'
    case 'started': return 'started'
    case 'completed': return 'done'
    case 'canceled': return 'canceled'
    default: return 'backlog'
  }
}
