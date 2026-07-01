import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Local stats/rollups store for bunion — an append-only event log in bun:sqlite (no external DB, no secrets;
// matches the thin/decoupled design — Linear stays the source of truth). One row per meaningful ticket
// transition + lifecycle event, carrying the codex thread id, cumulative tokens, and the routing account. Rich
// enough for dashboard rollups (throughput / spend / reliability) AND for debugging evals later: rank threads by
// cost / cycle-time / reworks / outcome, then pull the exact thread by id. All writes are best-effort — a stats
// failure must never take the daemon down.

export type StatKind = 'transition' | 'dispatch' | 'session_done' | 'session_fail' | 'deadlock' | 'cap'

export interface StatEvent {
  identifier: string
  kind: StatKind
  threadId?: string | null
  fromState?: string | null
  toState?: string | null
  totalTokens?: number | null
  account?: string | null
  host?: string | null
  detail?: string | null
}

export interface Stats {
  record(e: StatEvent): void
  daily(days: number): unknown[] // per-day throughput / spend / reliability
  threads(order: 'tokens' | 'cycle' | 'reworks' | 'recent', limit: number): unknown[] // per-ticket summary (best/worst)
  threadEvents(identifier: string, limit: number): unknown[] // one ticket's event timeline
  totals(): unknown
  close(): void
}

const SHIPPED = "('STG - Ready to merge','STG - Merged','Done')"
const REWORK_FROM = "('QA - Testing','QA - blocked')"
const ORDER: Record<string, string> = { tokens: 'tokens DESC', cycle: 'cycle_ms DESC', reworks: 'reworks DESC, tokens DESC', recent: 'last_ts DESC' }

export function openStats(path: string = join(homedir(), '.bunion', 'stats.db')): Stats {
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    identifier TEXT NOT NULL,
    kind TEXT NOT NULL,
    thread_id TEXT,
    from_state TEXT,
    to_state TEXT,
    total_tokens INTEGER,
    account TEXT,
    host TEXT,
    detail TEXT
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_ident ON events(identifier)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)')

  const ins = db.query(`INSERT INTO events (ts, identifier, kind, thread_id, from_state, to_state, total_tokens, account, host, detail)
    VALUES ($ts,$id,$kind,$thread,$from,$to,$tok,$acct,$host,$detail)`)

  // Per-day rollup: dispatched/shipped (distinct tickets), deadlocks/caps (events), and per-day token spend as the
  // sum of positive deltas of each ticket's cumulative total (LAG over the ticket's events).
  const dailyQ = db.query(`
    WITH d AS (
      SELECT date(ts/1000,'unixepoch','localtime') AS day, kind, to_state, identifier,
             total_tokens - LAG(total_tokens,1,0) OVER (PARTITION BY identifier ORDER BY ts, id) AS delta
      FROM events
    )
    SELECT day,
      COUNT(DISTINCT CASE WHEN kind='dispatch' THEN identifier END) AS dispatched,
      COUNT(DISTINCT CASE WHEN to_state IN ${SHIPPED} THEN identifier END) AS shipped,
      SUM(CASE WHEN kind='deadlock' THEN 1 ELSE 0 END) AS deadlocks,
      SUM(CASE WHEN kind='cap' THEN 1 ELSE 0 END) AS caps,
      SUM(CASE WHEN delta>0 THEN delta ELSE 0 END) AS tokens
    FROM d GROUP BY day ORDER BY day DESC LIMIT $days`)

  const threadBase = `
    SELECT identifier,
      MAX(thread_id) AS thread_id, MAX(account) AS account,
      MIN(ts) AS first_ts, MAX(ts) AS last_ts, MAX(ts)-MIN(ts) AS cycle_ms,
      MAX(total_tokens) AS tokens,
      SUM(CASE WHEN kind='transition' THEN 1 ELSE 0 END) AS transitions,
      SUM(CASE WHEN kind='transition' AND to_state='In Progress' AND from_state IN ${REWORK_FROM} THEN 1 ELSE 0 END) AS reworks,
      SUM(CASE WHEN kind='deadlock' THEN 1 ELSE 0 END) AS deadlocks,
      SUM(CASE WHEN kind='cap' THEN 1 ELSE 0 END) AS caps,
      (SELECT to_state FROM events x WHERE x.identifier=e.identifier AND x.to_state IS NOT NULL ORDER BY ts DESC, id DESC LIMIT 1) AS outcome
    FROM events e GROUP BY identifier`

  return {
    record(e) {
      try {
        ins.run({ $ts: Date.now(), $id: e.identifier, $kind: e.kind, $thread: e.threadId ?? null, $from: e.fromState ?? null, $to: e.toState ?? null, $tok: e.totalTokens ?? null, $acct: e.account ?? null, $host: e.host ?? null, $detail: e.detail ?? null })
      } catch {
        /* best-effort: stats must never break the daemon */
      }
    },
    daily(days) {
      try { return dailyQ.all({ $days: days }) as unknown[] } catch { return [] }
    },
    threads(order, limit) {
      try { return db.query(`${threadBase} ORDER BY ${ORDER[order] ?? ORDER.recent} LIMIT ?`).all(limit) as unknown[] } catch { return [] }
    },
    threadEvents(identifier, limit) {
      try { return db.query('SELECT ts,kind,from_state,to_state,total_tokens,detail FROM events WHERE identifier=? ORDER BY ts DESC, id DESC LIMIT ?').all(identifier, limit) as unknown[] } catch { return [] }
    },
    totals() {
      try { return db.query(`SELECT COUNT(DISTINCT identifier) AS tickets, COUNT(*) AS events, SUM(CASE WHEN kind='cap' THEN 1 ELSE 0 END) AS caps, SUM(CASE WHEN kind='deadlock' THEN 1 ELSE 0 END) AS deadlocks FROM events`).get() ?? {} } catch { return {} }
    },
    close() {
      try { db.close() } catch { /* ignore */ }
    },
  }
}
