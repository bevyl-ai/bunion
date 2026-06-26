import { comment, currentStateId, moveState } from './linear'
import { log, warn } from './log'
import type { Issue, Runtime, RunnerResult, Worker } from './types'

// Claim → run → settle. The claim is the Ready→Working transition (Linear is the source of truth, so the ticket
// drops out of the next poll on its own). The move is UNCONDITIONAL — Linear has no compare-and-swap — so the
// orchestrator's in-memory `inflight` set is the sole guard against double-pickup, which holds for a single daemon.
// Settle moves the ticket to review (PR) or escalate (decline/error) and comments — but only while it is still in
// Working, so a human who grabs or cancels it mid-run is never overridden.
export async function dispatch(rt: Runtime, worker: Worker, issue: Issue): Promise<void> {
  await moveState(rt.cfg, issue.id, rt.states.working)

  const r: RunnerResult = await worker.run(issue).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))

  if (r.ok && r.prUrl) {
    await moveIfWorking(rt, issue.id, rt.states.review)
    await comment(rt.cfg, issue.id, `bunion opened a PR: ${r.prUrl}`)
    log(`✓ ${issue.identifier} → ${r.prUrl}`)
  } else {
    const error = (r.error ?? 'unknown').slice(0, 600)
    await moveIfWorking(rt, issue.id, rt.states.escalate)
    await comment(rt.cfg, issue.id, r.escalated ? `bunion stopped without a PR: ${error}` : `bunion errored: ${error}`)
    warn(`✗ ${issue.identifier}: ${error.slice(0, 160)}`)
  }
}

async function moveIfWorking(rt: Runtime, issueId: string, target: string): Promise<void> {
  if ((await currentStateId(rt.cfg, issueId)) === rt.states.working) await moveState(rt.cfg, issueId, target)
}
