import { Database } from 'bun:sqlite'

// GitHub-side twin of the tracker mirror (tracker-mirror.ts): a durable local snapshot of the pull requests the
// factory is working or gating on, so the wait-tool's build gate and the pit-freshness checks read the brain
// instead of hammering the GitHub API from every worker VM. github-sync.ts owns all IO; this module is pure
// storage. Snapshots are normalized once at fetch time (PrSnapshot) so every consumer shares one shape.

export interface PrCheck {
  name: string
  result: 'pass' | 'fail' | 'pending' // NEUTRAL/SKIPPED contexts are dropped at normalization
}

export interface PrReview {
  login: string
  body: string
  submittedAt: string
  commitOid: string
}

export interface PrSnapshot {
  repo: string // owner/name
  number: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  mergeable: string // MERGEABLE | CONFLICTING | UNKNOWN
  mergeStateStatus: string // CLEAN | BLOCKED | DIRTY | UNKNOWN | …
  headRefOid: string
  updatedAt: string
  checks: PrCheck[]
  commits: { oid: string; messageHeadline: string }[] // newest last, for the [skip ci] code-sha dance
  reviews: PrReview[] // chronological
}

export class GithubMirror {
  private db: Database

  // Shares the brain's state database file with the tracker mirror (own table); ':memory:' for tests/one-shots.
  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run(`CREATE TABLE IF NOT EXISTS gh_prs (
      repo TEXT NOT NULL, number INTEGER NOT NULL, data TEXT NOT NULL, fetched_at INTEGER NOT NULL,
      PRIMARY KEY (repo, number)
    )`)
  }

  get(repo: string, number: number): { snapshot: PrSnapshot; fetchedAt: number } | null {
    const row = this.db.query('SELECT data, fetched_at FROM gh_prs WHERE repo = ? AND number = ?').get(repo, number) as { data: string; fetched_at: number } | null
    return row ? { snapshot: JSON.parse(row.data) as PrSnapshot, fetchedAt: row.fetched_at } : null
  }

  put(snapshot: PrSnapshot, nowMs: number = Date.now()): void {
    this.db.run(
      'INSERT INTO gh_prs (repo, number, data, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(repo, number) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at',
      [snapshot.repo, snapshot.number, JSON.stringify(snapshot), nowMs],
    )
  }

  // Tracked PRs whose snapshot is older than `staleMs` — the passive sweep refreshes these (pit freshness).
  stale(staleMs: number, limit: number, nowMs: number = Date.now()): { repo: string; number: number }[] {
    const rows = this.db.query('SELECT repo, number FROM gh_prs WHERE fetched_at < ? ORDER BY fetched_at LIMIT ?').all(nowMs - staleMs, limit) as { repo: string; number: number }[]
    return rows
  }

  tracked(): { repo: string; number: number }[] {
    return this.db.query('SELECT repo, number FROM gh_prs').all() as { repo: string; number: number }[]
  }

  close(): void {
    this.db.close()
  }
}
