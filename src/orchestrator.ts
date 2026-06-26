import { dispatch } from './dispatch'
import { comment, fetchByStates, moveState } from './linear'
import { log, warn } from './log'
import { resolveRuntime } from './runtime'
import { getWorker } from './worker'

// The daemon. Linear is the state machine: poll the ready states → claim (move to working) → run → settle. No queue,
// no broker, no local db — the board holds the state.
export async function start(): Promise<void> {
  const rt = await resolveRuntime()
  const { cfg, states } = rt
  const worker = getWorker(rt)

  // Crash recovery: anything sitting in Working at startup is an orphan from a previous run (nothing is in flight
  // yet) → move it to escalate so a human re-checks, instead of leaving it wedged. Assumes a single daemon and no
  // concurrent `bunion run` against this board — either would move tickets to Working behind the daemon's back.
  for (const orphan of await fetchByStates(cfg, [states.working])) {
    await moveState(cfg, orphan.id, states.escalate)
    await comment(cfg, orphan.id, 'bunion was interrupted mid-run — re-check, then drop back to ready to retry')
    warn(`recovered orphan ${orphan.identifier} → escalate`)
  }

  log(`bunion up · repo=${cfg.slug} · worker=${worker.kind} · cap=${cfg.maxConcurrent} · poll=${cfg.pollMs}ms`)
  const inflight = new Set<string>()

  for (;;) {
    try {
      if (inflight.size < cfg.maxConcurrent) {
        for (const issue of await fetchByStates(cfg, states.ready)) {
          if (inflight.size >= cfg.maxConcurrent) break
          if (inflight.has(issue.id)) continue
          inflight.add(issue.id)
          log(`→ ${issue.identifier}`)
          void dispatch(rt, worker, issue)
            .catch((e) => warn(`✗ ${issue.identifier}: ${e instanceof Error ? e.message : e}`))
            .finally(() => inflight.delete(issue.id))
        }
      }
    } catch (e) {
      warn(`poll error: ${e instanceof Error ? e.message : e}`)
    }
    await Bun.sleep(cfg.pollMs)
  }
}
