import { backpressure } from './backpressure'
import { runAgent } from './codex'
import { cleanup, hasChanges, prepareWorkspace, publish } from './git'
import { currentStateId } from './linear'
import { log } from './log'
import { renderWorkflow } from './workflow'
import type { Issue, Runtime, RunnerResult } from './types'

// The per-ticket pipeline, run in one worktree: checkout → agent → backpressure → reconcile → PR. It STOPS at the PR
// — the merge is the trust boundary. The dispatcher owns the Linear state writes; this just produces the result.
export async function runIssue(rt: Runtime, issue: Issue): Promise<RunnerResult> {
  const { cfg, states } = rt
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

    // Reconcile before publishing: if the ticket left the working state while the agent ran (a human cancelled,
    // grabbed, or resolved it), do not open a PR on it.
    if ((await currentStateId(cfg, issue.id)) !== states.working) {
      return { ok: false, escalated: true, error: 'ticket left the working state during the run — no PR opened' }
    }

    return { ok: true, prUrl: publish(cfg, ws, issue) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    cleanup(ws)
  }
}
