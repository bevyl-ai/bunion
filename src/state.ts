import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RunStatus } from './types'

export interface RunRow {
  issueId: string
  identifier: string
  status: RunStatus
  prUrl: string | null
  detail: string | null
  attempts: number
  startedAt: number
  updatedAt: number
}

let db: Database

export function initState(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  db = new Database(path)
  db.run(`CREATE TABLE IF NOT EXISTS runs (
    issue_id    TEXT PRIMARY KEY,
    identifier  TEXT NOT NULL,
    status      TEXT NOT NULL,
    pr_url      TEXT,
    detail      TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    next_at     INTEGER NOT NULL DEFAULT 0,
    started_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS skips (issue_id TEXT PRIMARY KEY, reason TEXT NOT NULL)`)
}

// Claim a ticket for dispatch. Succeeds for a brand-new ticket, OR for one parked in `retry` whose backoff has
// elapsed — so a transient failure is re-attempted, not permanently burned. A `pr_open`/`escalated`/terminal-`failed`
// row is never re-claimed. The PK insert + the conditional update are atomic, so two polls can't both win a ticket.
export function claim(issueId: string, identifier: string): boolean {
  const now = Date.now()
  const fresh = db.run(
    `INSERT OR IGNORE INTO runs (issue_id, identifier, status, attempts, next_at, started_at, updated_at)
     VALUES (?, ?, 'running', 1, 0, ?, ?)`,
    [issueId, identifier, now, now],
  )
  if (fresh.changes > 0) return true
  const retried = db.run(
    `UPDATE runs SET status = 'running', attempts = attempts + 1, updated_at = ?
     WHERE issue_id = ? AND status = 'retry' AND next_at <= ?`,
    [now, issueId, now],
  )
  return retried.changes > 0
}

export function setStatus(issueId: string, status: RunStatus, opts: { prUrl?: string; detail?: string } = {}): void {
  db.run(`UPDATE runs SET status = ?, pr_url = COALESCE(?, pr_url), detail = ?, updated_at = ? WHERE issue_id = ?`, [
    status,
    opts.prUrl ?? null,
    opts.detail ?? null,
    Date.now(),
    issueId,
  ])
}

// Record a failed attempt. Below the ceiling it parks the ticket in `retry` with exponential backoff so the loop
// re-dispatches it once the backoff elapses; at the ceiling it becomes terminally `failed`. Returns which happened
// so the caller can comment accordingly.
export function fail(issueId: string, error: string, maxAttempts: number, backoffMs: number): 'retry' | 'gaveup' {
  const row = db.query(`SELECT attempts FROM runs WHERE issue_id = ?`).get(issueId) as { attempts: number } | null
  const attempts = row?.attempts ?? 1
  if (attempts >= maxAttempts) {
    setStatus(issueId, 'failed', { detail: error })
    return 'gaveup'
  }
  const nextAt = Date.now() + backoffMs * 2 ** (attempts - 1)
  db.run(`UPDATE runs SET status = 'retry', next_at = ?, detail = ?, updated_at = ? WHERE issue_id = ?`, [
    nextAt,
    error.slice(0, 1000),
    Date.now(),
    issueId,
  ])
  return 'retry'
}

// The agent deliberately produced no change, or the ticket was resolved/cancelled mid-run. Terminal and NOT retried
// (distinct from `failed`, so `bunion status` shows a declination apart from a real failure).
export function escalate(issueId: string, detail: string): void {
  setStatus(issueId, 'escalated', { detail })
}

// A `running` row at startup means a previous process died mid-run. Park it in `retry` so the loop re-dispatches it
// rather than wedging it forever.
export function recoverStale(): number {
  const r = db.run(
    `UPDATE runs SET status = 'retry', next_at = 0, detail = 'interrupted — will retry', updated_at = ? WHERE status = 'running'`,
    [Date.now()],
  )
  return r.changes
}

// Skip-comment de-dup that survives restarts: returns true only the first time a given (issue, reason) is seen, so an
// ineligible-but-labeled ticket is not re-commented on every poll or restart.
export function recordSkip(issueId: string, reason: string): boolean {
  const row = db.query(`SELECT reason FROM skips WHERE issue_id = ?`).get(issueId) as { reason: string } | null
  if (row?.reason === reason) return false
  db.run(`INSERT INTO skips (issue_id, reason) VALUES (?, ?) ON CONFLICT(issue_id) DO UPDATE SET reason = excluded.reason`, [
    issueId,
    reason,
  ])
  return true
}

export function listRuns(limit = 50): RunRow[] {
  return db
    .query(
      `SELECT issue_id AS issueId, identifier, status, pr_url AS prUrl, detail, attempts, started_at AS startedAt, updated_at AS updatedAt
       FROM runs ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as RunRow[]
}
