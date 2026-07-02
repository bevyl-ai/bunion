import { fetchBoard, fetchCommentsUpdatedSince, fetchInitialIssues, fetchIssuesUpdatedSince, graphql, isRateLimited } from './linear'
import type { TrackerMirror } from './tracker-mirror'
import type { Config, Issue } from './types'

// The mirror's IO: delta ingestion, the durable-write drain, and the drift audit. Called from the orchestrator's
// poll tick — this replaces the old full-board query with (usually) two tiny delta requests, which is what actually
// keeps the factory under Linear's hourly quota without throttling agents.

const INITIAL_WINDOW_MS = 60 * 24 * 60 * 60_000 // first hydration: all live tickets + 60 days of touched history
const AUDIT_INTERVAL_MS = 60 * 60_000 // hourly full-board reconciliation against Linear (catches missed deltas)
const CURSOR_ISSUES = 'issues_cursor'
const CURSOR_COMMENTS = 'comments_cursor'
const META_AUDIT = 'last_audit_ms'

// One sync pass: initial hydration when the mirror is empty, else issue + comment deltas. Comment-delta failure is
// non-fatal (threads fall back to per-read refetch via the stale gate); issue-delta failure propagates — the caller
// treats it exactly like the old poll failing.
export async function syncMirror(cfg: Config, mirror: TrackerMirror, warn: (msg: string) => void, nowMs: number = Date.now()): Promise<void> {
  const cursor = mirror.getMeta(CURSOR_ISSUES)
  if (!cursor) {
    const since = new Date(nowMs - INITIAL_WINDOW_MS).toISOString()
    const issues = await fetchInitialIssues(cfg, since)
    mirror.upsertIssues(issues)
    mirror.setMeta(CURSOR_ISSUES, maxUpdatedAt(issues) ?? new Date(nowMs).toISOString())
    mirror.setMeta(CURSOR_COMMENTS, new Date(nowMs).toISOString())
    mirror.setMeta(META_AUDIT, String(nowMs))
    warn(`mirror: initial hydration — ${issues.length} issues`)
    return
  }
  const issues = await fetchIssuesUpdatedSince(cfg, cursor)
  if (issues.length > 0) {
    mirror.upsertIssues(issues)
    const next = maxUpdatedAt(issues)
    if (next && next > cursor) mirror.setMeta(CURSOR_ISSUES, next)
  }
  try {
    const cCursor = mirror.getMeta(CURSOR_COMMENTS) ?? cursor
    const deltas = await fetchCommentsUpdatedSince(cfg, cCursor)
    if (deltas.length > 0) {
      mirror.applyCommentDeltas(deltas)
      const next = deltas.reduce((m, d) => (d.updatedAt > m ? d.updatedAt : m), cCursor)
      if (next > cCursor) mirror.setMeta(CURSOR_COMMENTS, next)
    }
    mirror.touchCommentSync(nowMs) // every hydrated thread is now as fresh as this pass
  } catch (e) {
    warn(`mirror: comment-delta pass failed (threads fall back to per-read fetch): ${e instanceof Error ? e.message : String(e)}`)
  }
}

// The board view the orchestrator dispatches from — same semantics the old fetchBoard server-side query had
// (non-canceled, active or completed within the last day, opted in by label or delegation), computed locally.
export function boardFromMirror(cfg: Config, mirror: TrackerMirror, nowMs: number = Date.now()): Issue[] {
  const cutoff = new Date(nowMs - 24 * 60 * 60_000).toISOString()
  const optIn = (i: Issue): boolean => {
    const labels = cfg.tracker.requiredLabels
    const byLabel = labels.length > 0 && labels.every((l) => i.labels.includes(l))
    const byDelegate = cfg.tracker.appActorId != null && i.delegateId === cfg.tracker.appActorId
    return labels.length === 0 && cfg.tracker.appActorId == null ? true : byLabel || byDelegate
  }
  return mirror.allIssues().filter((i) => i.stateType !== 'canceled' && (i.completedAt == null || i.completedAt > cutoff) && optIn(i))
}

// Drain due queued writes through the shared gate. Success (2xx + no errors) → done; anything else → backoff and
// keep. RATELIMITED responses already armed the gate's cooldown inside graphql(), so the next drain waits it out.
export async function drainWrites(cfg: Config, mirror: TrackerMirror, warn: (msg: string) => void, limit = 5): Promise<void> {
  for (const w of mirror.dueWrites(limit)) {
    try {
      const r = await graphql(cfg, w.query, w.variables)
      const errs = (r.body as { errors?: unknown[] }).errors
      if (r.httpOk && !(Array.isArray(errs) && errs.length > 0)) {
        mirror.completeWrite(w.seq)
      } else {
        mirror.failWrite(w.seq)
        if (w.attempts === 0 || isRateLimited(r.body)) warn(`mirror: queued write deferred (${w.note ?? 'unlabeled'}, attempt ${w.attempts + 1})`)
      }
    } catch (e) {
      mirror.failWrite(w.seq)
      warn(`mirror: queued write errored (${w.note ?? 'unlabeled'}): ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

// Hourly reconciliation: re-fetch the real board and upsert it wholesale — self-heals any delta the mirror missed
// (downtime, webhook-less edits that didn't bump updatedAt, etc.) and reports drift instead of hiding it.
export async function auditMirror(cfg: Config, mirror: TrackerMirror, warn: (msg: string) => void, nowMs: number = Date.now()): Promise<void> {
  const last = Number(mirror.getMeta(META_AUDIT) ?? 0)
  if (nowMs - last < AUDIT_INTERVAL_MS) return
  mirror.setMeta(META_AUDIT, String(nowMs)) // set BEFORE the fetch so a failing audit can't retry-storm
  const real = await fetchBoard(cfg)
  const drifted = real.filter((r) => {
    const m = mirror.getIssue(r.id)
    return !m || (r.updatedAt ?? '') > (m.updatedAt ?? '')
  })
  if (drifted.length > 0) {
    warn(`mirror: audit found ${drifted.length} drifted issue(s) — healed (${drifted.slice(0, 5).map((i) => i.identifier).join(', ')}${drifted.length > 5 ? ', …' : ''})`)
    mirror.upsertIssues(drifted)
  }
}

function maxUpdatedAt(issues: Issue[]): string | null {
  let max: string | null = null
  for (const i of issues) if (i.updatedAt && (max == null || i.updatedAt > max)) max = i.updatedAt
  return max
}
