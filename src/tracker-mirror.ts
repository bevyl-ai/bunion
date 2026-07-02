import { Database } from 'bun:sqlite'
import type { Issue } from './types'

// The tracker spine: a DURABLE local mirror of Linear on the brain — the factory's single source of truth for
// reads, and a durable queue for the orchestrator's own writes. This is the sync-engine shape (Linear itself is
// built on one), not a query cache: entities live in SQLite, delta polls + mutation payloads keep them current
// (tracker-sync.ts owns the IO), and every consumer — dispatch, dashboard, agents' linear_read, notes, workpads —
// reads here instead of hitting the API. Why it exists: agents re-reading tickets every turn blew Linear's
// 2,500 req/h quota, and fire-and-forget orchestrator writes silently lost state transitions when it did.
//
// This module is IO-free apart from its own database file: no network, callers own all Linear traffic.

export interface StoredComment {
  id: string
  body: string
  createdAt: string // ISO
  author: string | null // display name (user or bot actor), null if the payload had neither
}

export interface QueuedWrite {
  seq: number
  query: string
  variables: Record<string, unknown>
  attempts: number
  note: string | null
}

// Comments served without refetch while their last sync touch is younger than this. tracker-sync touches ALL
// hydrated threads after each successful comment-delta pass, so in steady state this never expires; it only bites
// after the daemon was down/failing long enough that deltas may have been missed.
export const COMMENTS_STALE_MS = 10 * 60_000

const WRITE_BACKOFF_BASE_MS = 30_000 // retry delay doubles per attempt: 30s, 1m, 2m, … capped below
const WRITE_BACKOFF_CAP_MS = 15 * 60_000

export class TrackerMirror {
  private db: Database

  // `path` is a filesystem path (persists across restarts) or ':memory:' for one-shot runs and tests.
  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run(`CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY, identifier TEXT UNIQUE NOT NULL, data TEXT NOT NULL, updated_at TEXT
    )`)
    this.db.run(`CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, author TEXT
    )`)
    this.db.run('CREATE INDEX IF NOT EXISTS comments_issue ON comments(issue_id, created_at)')
    this.db.run('CREATE TABLE IF NOT EXISTS comment_sync (issue_id TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL)')
    this.db.run(`CREATE TABLE IF NOT EXISTS writes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, variables TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, note TEXT
    )`)
    this.db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  }

  // ── issues ────────────────────────────────────────────────────────────────────────────────────────────────────

  upsertIssues(issues: Issue[]): void {
    const stmt = this.db.prepare('INSERT INTO issues (id, identifier, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET identifier = excluded.identifier, data = excluded.data, updated_at = excluded.updated_at')
    const tx = this.db.transaction((batch: Issue[]) => {
      for (const i of batch) stmt.run(i.id, i.identifier, JSON.stringify(i), i.updatedAt ?? null)
    })
    tx(issues)
  }

  // Poll-compatible alias so the tool/wiring surface matches the previous in-memory store.
  hydrateBoard(issues: Issue[]): void {
    this.upsertIssues(issues)
  }

  getIssue(idOrIdentifier: string): Issue | null {
    const row = this.db.query('SELECT data FROM issues WHERE id = ?1 OR identifier = ?1').get(idOrIdentifier) as { data: string } | null
    return row ? (JSON.parse(row.data) as Issue) : null
  }

  allIssues(): Issue[] {
    const rows = this.db.query('SELECT data FROM issues').all() as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as Issue)
  }

  issueCount(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM issues').get() as { n: number }).n
  }

  // ── comments ──────────────────────────────────────────────────────────────────────────────────────────────────

  // The thread for an issue UUID, or null when never hydrated / possibly stale — null tells the caller to fetch
  // from Linear and setComments().
  getComments(issueId: string, nowMs: number = Date.now()): StoredComment[] | null {
    const sync = this.db.query('SELECT fetched_at FROM comment_sync WHERE issue_id = ?').get(issueId) as { fetched_at: number } | null
    if (!sync || nowMs - sync.fetched_at > COMMENTS_STALE_MS) return null
    const rows = this.db.query('SELECT id, body, created_at, author FROM comments WHERE issue_id = ? ORDER BY created_at').all(issueId) as { id: string; body: string; created_at: string; author: string | null }[]
    return rows.map((r) => ({ id: r.id, body: r.body, createdAt: r.created_at, author: r.author }))
  }

  setComments(issueId: string, list: StoredComment[], nowMs: number = Date.now()): void {
    const tx = this.db.transaction(() => {
      this.db.run('DELETE FROM comments WHERE issue_id = ?', [issueId])
      const stmt = this.db.prepare('INSERT INTO comments (id, issue_id, body, created_at, author) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, author = excluded.author')
      for (const c of list) stmt.run(c.id, issueId, c.body, c.createdAt, c.author)
      this.db.run('INSERT INTO comment_sync (issue_id, fetched_at) VALUES (?, ?) ON CONFLICT(issue_id) DO UPDATE SET fetched_at = excluded.fetched_at', [issueId, nowMs])
    })
    tx()
  }

  // Apply comment deltas from the sync pass: upsert into HYDRATED threads only (a delta landing on a thread we
  // never fetched would masquerade as the whole thread on the next read). Edits update in place via the id upsert.
  applyCommentDeltas(deltas: (StoredComment & { issueId: string })[]): void {
    const stmt = this.db.prepare('INSERT INTO comments (id, issue_id, body, created_at, author) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, author = excluded.author')
    const hydrated = this.db.prepare('SELECT 1 FROM comment_sync WHERE issue_id = ?')
    const tx = this.db.transaction(() => {
      for (const d of deltas) if (hydrated.get(d.issueId)) stmt.run(d.id, d.issueId, d.body, d.createdAt, d.author)
    })
    tx()
  }

  // After a successful comment-delta pass every hydrated thread is as fresh as the sync — restart the stale clock.
  touchCommentSync(nowMs: number = Date.now()): void {
    this.db.run('UPDATE comment_sync SET fetched_at = ?', [nowMs])
  }

  // ── mutation write-back (Apollo-style: the mutation's own payload updates the mirror, no refetch) ─────────────

  applyMutation(query: string, variables: Record<string, unknown>, body: unknown): void {
    const created = extractCreatedComment(body)
    const issueId = extractIssueId(query, variables, body)
    if (created && issueId) {
      const hydrated = this.db.query('SELECT 1 FROM comment_sync WHERE issue_id = ?').get(issueId)
      if (hydrated) {
        this.db.run('INSERT INTO comments (id, issue_id, body, created_at, author) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, author = excluded.author', [created.id, issueId, created.body, created.createdAt, created.author])
        this.db.run('UPDATE comment_sync SET fetched_at = ? WHERE issue_id = ?', [Date.now(), issueId])
      }
      return
    }
    if (issueId) {
      this.invalidateComments(issueId)
      return
    }
    const mentioned = `${query} ${JSON.stringify(variables)}`.match(UUID_RE)
    if (mentioned) for (const id of mentioned) this.invalidateComments(id)
    else this.db.run('DELETE FROM comment_sync')
  }

  invalidateComments(issueId: string): void {
    this.db.run('DELETE FROM comment_sync WHERE issue_id = ?', [issueId])
    this.db.run('DELETE FROM comments WHERE issue_id = ?', [issueId])
  }

  // ── durable write queue (orchestrator-owned writes: deadlock moves, sweep comments) ───────────────────────────

  enqueueWrite(query: string, variables: Record<string, unknown>, note?: string): void {
    this.db.run('INSERT INTO writes (query, variables, attempts, next_at, note) VALUES (?, ?, 0, ?, ?)', [query, JSON.stringify(variables), Date.now(), note ?? null])
  }

  dueWrites(limit: number, nowMs: number = Date.now()): QueuedWrite[] {
    const rows = this.db.query('SELECT seq, query, variables, attempts, note FROM writes WHERE next_at <= ? ORDER BY seq LIMIT ?').all(nowMs, limit) as { seq: number; query: string; variables: string; attempts: number; note: string | null }[]
    return rows.map((r) => ({ seq: r.seq, query: r.query, variables: JSON.parse(r.variables) as Record<string, unknown>, attempts: r.attempts, note: r.note }))
  }

  completeWrite(seq: number): void {
    this.db.run('DELETE FROM writes WHERE seq = ?', [seq])
  }

  // Exponential backoff; the write stays queued forever (a lost state transition is worse than a late one — the
  // drift audit + operator can see a stuck queue via pendingWrites()).
  failWrite(seq: number, nowMs: number = Date.now()): void {
    const row = this.db.query('SELECT attempts FROM writes WHERE seq = ?').get(seq) as { attempts: number } | null
    if (!row) return
    const delay = Math.min(WRITE_BACKOFF_BASE_MS * 2 ** row.attempts, WRITE_BACKOFF_CAP_MS)
    this.db.run('UPDATE writes SET attempts = attempts + 1, next_at = ? WHERE seq = ?', [nowMs + delay, seq])
  }

  pendingWrites(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM writes').get() as { n: number }).n
  }

  // ── meta (sync cursors, audit timestamps) ──────────────────────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | null
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value])
  }

  close(): void {
    this.db.close()
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
