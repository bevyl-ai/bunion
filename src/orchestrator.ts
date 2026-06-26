import { loadConfig, type Config } from './config'
import { autoMergeable, eligible } from './eligibility'
import { comment, fetchCandidates } from './linear'
import { log, warn } from './log'
import { claim, escalate, fail, initState, recordSkip, recoverStale, setStatus } from './state'
import { getWorker } from './worker'
import type { Issue, RunnerResult } from './types'

// The daemon. Poll Linear → filter by the gate → claim → dispatch up to the concurrency cap → record + report.
// No queue, no broker: the loop is the orchestrator and SQLite holds the state.
export async function start(): Promise<void> {
  const cfg = loadConfig()
  initState(cfg.stateDb)
  const recovered = recoverStale()
  if (recovered) warn(`recovered ${recovered} interrupted run(s) → retry`)

  const worker = getWorker(cfg)
  log(`bunion up · repo=${cfg.slug} · worker=${worker.kind} · cap=${cfg.maxConcurrent} · poll=${cfg.pollMs}ms`)

  const inflight = new Set<string>()

  for (;;) {
    try {
      if (inflight.size < cfg.maxConcurrent) {
        for (const issue of await fetchCandidates(cfg)) {
          if (inflight.size >= cfg.maxConcurrent) break
          if (inflight.has(issue.id)) continue

          const v = eligible(issue, cfg)
          if (!v.ok) {
            if (recordSkip(issue.id, v.reason)) await comment(cfg, issue.id, `bunion skipped: ${v.reason}`)
            continue
          }

          if (!claim(issue.id, issue.identifier)) continue
          inflight.add(issue.id)
          log(`→ ${issue.identifier} (${issue.component})`)

          void worker
            .run(issue)
            .then((r) => settle(cfg, issue, r))
            .catch((e) => settle(cfg, issue, { ok: false, error: e instanceof Error ? e.message : String(e) }))
            .finally(() => inflight.delete(issue.id))
        }
      }
    } catch (e) {
      warn(`poll error: ${e instanceof Error ? e.message : e}`)
    }
    await Bun.sleep(cfg.pollMs)
  }
}

// Apply one run's outcome: open PR → pr_open; deliberate decline / vanished ticket → escalated (terminal); any other
// error → retry with backoff until the attempt ceiling, then terminal failed.
async function settle(cfg: Config, issue: Issue, r: RunnerResult): Promise<void> {
  if (r.ok && r.prUrl) {
    setStatus(issue.id, 'pr_open', { prUrl: r.prUrl })
    const note = autoMergeable(issue, cfg) ? ' (auto-merge eligible)' : ''
    await comment(cfg, issue.id, `bunion opened a PR: ${r.prUrl}${note}`)
    log(`✓ ${issue.identifier} → ${r.prUrl}`)
    return
  }

  const error = (r.error ?? 'unknown').slice(0, 600)

  if (r.escalated) {
    escalate(issue.id, error)
    await comment(cfg, issue.id, `bunion stopped without a PR: ${error}`)
    log(`⊘ ${issue.identifier} escalated: ${error.slice(0, 120)}`)
    return
  }

  const outcome = fail(issue.id, error, cfg.maxAttempts, cfg.retryBackoffMs)
  await comment(
    cfg,
    issue.id,
    outcome === 'retry' ? `bunion hit an error, will retry: ${error}` : `bunion failed after ${cfg.maxAttempts} attempts: ${error}`,
  )
  warn(`✗ ${issue.identifier} (${outcome}): ${error.slice(0, 160)}`)
}
