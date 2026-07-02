import type { Issue } from './types'

// A normalized in-memory view of the tracker — the brain's single source of truth for reads, so agents stop
// re-fetching the same ticket + comments from Linear every turn (the demand that blew the 2,500 req/h quota;
// throttling the gate just starved the factory). Apollo-style, minus the framework:
//
//   • ISSUES are hydrated wholesale by the orchestrator's existing 30s poll — zero extra API cost, never staler
//     than one poll interval.
//   • COMMENTS are fetched from Linear ONCE per ticket (by the linear_read tool), then kept current by applying
//     each mutation's own response payload (commentCreate returns the created comment — append it, no refetch).
//     A TTL bounds staleness from writers the store can't see (humans, other tools).
//
// The store is pure and synchronous: all Linear IO lives in the callers (linear.ts fetchers, the tools), which
// keeps this testable and keeps one obvious place where entities change.

export interface StoredComment {
  id: string
  body: string
  createdAt: string // ISO
  author: string | null // display name (user or bot actor), null if the payload had neither
}

export const COMMENTS_TTL_MS = 5 * 60_000 // refetch window for comments written by actors the store can't observe

export class LinearStore {
  private byId = new Map<string, Issue>()
  private byIdentifier = new Map<string, Issue>()
  private comments = new Map<string, { list: StoredComment[]; fetchedAt: number }>() // key: issue UUID

  // Replace the issue view with this poll's board. Issues that left the board stay resident (an agent may still
  // be finishing a ticket that just went terminal); memory is bounded by the team's ticket count.
  hydrateBoard(issues: Issue[]): void {
    for (const i of issues) {
      this.byId.set(i.id, i)
      this.byIdentifier.set(i.identifier, i)
    }
  }

  getIssue(idOrIdentifier: string): Issue | null {
    return this.byId.get(idOrIdentifier) ?? this.byIdentifier.get(idOrIdentifier) ?? null
  }

  // Comments for an issue UUID, or null when absent/stale — null tells the caller to fetch and setComments().
  getComments(issueId: string, nowMs: number = Date.now()): StoredComment[] | null {
    const entry = this.comments.get(issueId)
    if (!entry || nowMs - entry.fetchedAt > COMMENTS_TTL_MS) return null
    return entry.list
  }

  setComments(issueId: string, list: StoredComment[], nowMs: number = Date.now()): void {
    this.comments.set(issueId, { list, fetchedAt: nowMs })
  }

  // Keep the store current from a mutation's OWN response instead of refetching. commentCreate with the created
  // comment in the payload → append in place (and refresh the TTL clock: the store just observed the tail of the
  // thread). Anything else that names an issue → drop that issue's comments so the next read refetches. A mutation
  // naming nothing recognizable drops all comments — correctness over warmth, and it's rare.
  applyMutation(query: string, variables: Record<string, unknown>, body: unknown): void {
    const created = extractCreatedComment(body)
    const issueId = extractIssueId(query, variables, body)
    if (created && issueId) {
      const entry = this.comments.get(issueId)
      if (entry) this.comments.set(issueId, { list: [...entry.list, created], fetchedAt: Date.now() })
      return
    }
    if (issueId) {
      this.comments.delete(issueId)
      return
    }
    const mentioned = `${query} ${JSON.stringify(variables)}`.match(UUID_RE)
    if (mentioned) for (const id of mentioned) this.comments.delete(id)
    else this.comments.clear()
  }
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

// The created comment from a commentCreate payload, when the agent's mutation selected enough fields to store it.
function extractCreatedComment(body: unknown): StoredComment | null {
  const c = (body as { data?: { commentCreate?: { comment?: Record<string, unknown> } } })?.data?.commentCreate?.comment
  if (!c || typeof c.id !== 'string' || typeof c.body !== 'string') return null
  const user = c.user as { displayName?: unknown; name?: unknown } | undefined
  const bot = c.botActor as { name?: unknown } | undefined
  const author = [user?.displayName, user?.name, bot?.name].find((v) => typeof v === 'string') as string | undefined
  return { id: c.id, body: c.body, createdAt: typeof c.createdAt === 'string' ? c.createdAt : new Date().toISOString(), author: author ?? null }
}

// The issue UUID a mutation targets: variables.input.issueId (commentCreate), a returned issue id in the payload
// (issueUpdate selections often include it), else the first UUID inlined in the query text.
function extractIssueId(query: string, variables: Record<string, unknown>, body: unknown): string | null {
  const input = variables.input
  const fromInput = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>).issueId : undefined
  if (typeof fromInput === 'string') return fromInput
  const data = (body as { data?: Record<string, unknown> })?.data
  if (data && typeof data === 'object') {
    for (const v of Object.values(data)) {
      const issue = (v as { issue?: { id?: unknown } })?.issue
      if (issue && typeof issue.id === 'string') return issue.id
      const comment = (v as { comment?: { issue?: { id?: unknown } } })?.comment
      if (comment?.issue && typeof comment.issue.id === 'string') return comment.issue.id
    }
  }
  const m = query.match(UUID_RE)
  return m ? m[0]! : null
}
