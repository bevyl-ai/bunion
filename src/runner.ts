import { backpressure } from './backpressure'
import { runAgent } from './codex'
import { cleanup, hasChanges, prepareWorkspace, publish } from './git'
import { currentState, fetchIssue } from './linear'
import { log } from './log'
import { renderWorkflow } from './workflow'
import type { Config } from './config'
import type { Issue, RunnerResult } from './types'

// The per-ticket pipeline, run in one worktree: checkout → agent → backpressure → reconcile → PR. It STOPS at the PR
// — the merge is the trust boundary. An empty diff is an escalation (the agent declined), not a success.
export async function runIssue(cfg: Config, issue: Issue): Promise<RunnerResult> {
  const ws = prepareWorkspace(cfg, issue)
  try {
    if (process.env.DRY_RUN) {
      log(`[dry] would run codex on ${issue.identifier} in ${ws.dir}`)
      return { ok: false, error: 'dry run — codex not invoked' }
    }

    const cx = runAgent(ws.dir, renderWorkflow(cfg.workflowPath, issue), cfg)
    if (!cx.ok) return { ok: false, error: `codex failed:\n${cx.combined.trim().slice(-1000)}` }
    if (!hasChanges(ws)) return { ok: false, escalated: true, error: 'agent made no changes' }

    const bp = backpressure(cfg, ws)
    if (!bp.ok) return { ok: false, error: bp.log }

    // Reconcile before publishing: if a human cancelled or resolved the ticket while the agent worked, do not open a
    // PR on it. Terminal, not retried.
    const live = await currentState(cfg, issue.id)
    if (live === 'done' || live === 'canceled') {
      return { ok: false, escalated: true, error: `ticket moved to '${live}' during the run — no PR opened` }
    }

    return { ok: true, prUrl: publish(cfg, ws, issue) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    cleanup(ws)
  }
}

// Fetch-then-run, for the per-VM runner entrypoint (and any direct caller).
export async function runById(cfg: Config, identifier: string): Promise<RunnerResult> {
  return runIssue(cfg, await fetchIssue(cfg, identifier))
}
