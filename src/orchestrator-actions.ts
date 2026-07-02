import { log } from './log'
import { moveIssue } from './linear'
import { norm } from './orchestrator-predicates'
import type { Dispatcher } from './orchestrator-dispatch'
import type { Placement } from './orchestrator-placement'
import type { RolePool } from './orchestrator-roles'
import { utcDay, type PersistedState } from './orchestrator-state'
import { grandTotal } from './tokens'
import type { TrackerMirror } from './tracker-mirror'
import { removeWorkspace } from './workspace'
import type { Config, Issue } from './types'

export type Actions = ReturnType<typeof createActions>

export function createActions(getCfg: () => Config, state: PersistedState, placement: Placement, dispatcher: Dispatcher, roles: RolePool, mirror: TrackerMirror, summaries: Map<string, string>, notesFetched: Set<string>, getLastBoard: () => Issue[]) {
  // Toggle the panic switch. On pause, halt every running pipeline agent + pool role so the gateway/Linear stop being
  // hit immediately; dispatch stays off (guarded in the loop/retry/role paths) until resumed. The poll keeps running.
  const setPaused = (v: boolean): void => {
    state.setPaused(v)
    if (v) {
      for (const id of [...dispatcher.running.keys()]) dispatcher.stopRun(id)
      roles.stopAll()
      log('■ factory PAUSED by operator — dispatch off, all running agents halted')
    } else {
      log('▶ factory RESUMED by operator')
    }
  }

  // BEV audit: `bump` is the only action that grants headroom before reopening a cap-tripped ticket — but
  // to-qa/to-build/move: ALSO reopen a Factory - Needs Engineer ticket into an active state (the dashboard offers them right
  // there next to Bump), and none of them touch ticketGrants. The ticket's total is still >= the un-bumped cap, so
  // the very next poll's blast-radius check re-trips it straight back to Factory - Needs Engineer — silently discarding the
  // reopen. Call this before any move that might reopen a capped ticket; it's a no-op unless the ticket is
  // currently Factory - Needs Engineer AND genuinely over its cap (not parked there for some other reason).
  const grantIfCapped = (identifier: string, issue: Issue): void => {
    if (norm(issue.state) !== 'factory - needs engineer') return
    if (grandTotal(state.tokens, identifier) < state.effectiveCap(identifier)) return
    const inc = state.capClearIncrementFor(identifier)
    state.ticketGrants.set(identifier, (state.ticketGrants.get(identifier) ?? 0) + inc)
    state.saveGrants()
    log(`action: ${identifier} budget +${Math.round(inc / 1e6)}M (auto, reopening a capped ticket)`)
  }

  // Operator actions = pure pipeline transitions. The thread carries context (chat + prior phases), so an action just
  // advances the ticket and the next dispatch resumes the same thread on the same worker. `restart` is the hard reset:
  // wipe the workspace AND drop the thread so the ticket replans from scratch.
  const onAction = async (identifier: string, action: string): Promise<{ ok: boolean; msg?: string }> => {
    if (identifier === '__pause__') {
      setPaused(!state.paused)
      return { ok: true, msg: state.paused ? 'factory paused' : 'factory resumed' }
    }
    if (action === 'pause') {
      // Per-role pause: stop THIS pool role's cadence runs independently of the global factory pause; persisted.
      if (!getCfg().roles.some((r) => r.name === identifier)) return { ok: false, msg: `unknown role: ${identifier}` }
      if (state.rolePaused.has(identifier)) state.rolePaused.delete(identifier)
      else state.rolePaused.add(identifier)
      state.saveRolePaused()
      const now = state.rolePaused.has(identifier)
      log(`action: ${identifier} ${now ? 'paused' : 'resumed'} (operator)`)
      return { ok: true, msg: `${identifier} ${now ? 'paused' : 'resumed'}` }
    }
    if (action === 'grant') {
      // Operator top-up: extend a capped pool role by another day's allowance for today only (resets at UTC midnight).
      const role = getCfg().roles.find((r) => r.name === identifier)
      if (!role) return { ok: false, msg: `unknown role: ${identifier}` }
      if (role.maxPerDay == null) return { ok: false, msg: `${identifier} is uncapped — nothing to grant` }
      const day = utcDay()
      const r = state.roleQuota.get(identifier)
      if (r && r.day === day) r.granted = (r.granted ?? 0) + role.maxPerDay
      else state.roleQuota.set(identifier, { day, count: 0, granted: role.maxPerDay })
      state.saveQuota()
      log(`action: granted ${identifier} +${role.maxPerDay} tickets for today (operator)`)
      return { ok: true, msg: `${identifier} +${role.maxPerDay} granted for today` }
    }
    if (action === 'run') {
      // Operator manual run: dispatch a pool role NOW, skipping its cadence wait + the daily-cap gate (the
      // linear_graphql tool still enforces filing limits, so a capped role runs + reports but files nothing).
      const i = getCfg().roles.findIndex((r) => r.name === identifier)
      if (i < 0) return { ok: false, msg: `unknown role: ${identifier}` }
      if (state.paused) return { ok: false, msg: 'factory is paused — resume first' }
      if (state.rolePaused.has(identifier)) return { ok: false, msg: `${identifier} is paused — resume it first` }
      if (roles.roleRunning.has(identifier)) return { ok: false, msg: `${identifier} is already running` }
      roles.dispatchRole(getCfg().roles[i]!, i, true)
      return { ok: true, msg: `${identifier} run started` }
    }
    const issue = getLastBoard().find((i) => i.identifier === identifier)
    if (!issue) return { ok: false, msg: 'ticket not on the board' }
    // Teardown host (restart + cancel removeWorkspace). placement is in-memory and empty after a daemon restart, but
    // a parked/idle ticket's remote checkout still lives on its persisted threadRecs host — fall back to that, or the
    // remote workspace leaks (removeWorkspace(_, null) only wipes the local path).
    const host = placement.placement.get(issue.id) ?? state.threadRecs.get(issue.id)?.host ?? null
    try {
      if (action === 'bump') {
        // Operator budget bump: grant enough headroom to actually clear this ticket's current deficit (plus one
        // full cap's worth of real working room), kept cumulative — its spend is not erased. BEV re-audit: a flat
        // +hardTokenCap used to require dozens of repeated clicks to unstick a ticket that was wildly over cap.
        const inc = state.capClearIncrementFor(identifier)
        state.ticketGrants.set(identifier, (state.ticketGrants.get(identifier) ?? 0) + inc)
        state.saveGrants()
        const cap = state.effectiveCap(identifier)
        log(`action: ${identifier} budget +${Math.round(inc / 1e6)}M → ${Math.round(cap / 1e6)}M cap (operator)`)
        const s = norm(issue.state)
        if (s === 'factory - needs engineer' || s === 'qa - blocked') {
          // It was parked (likely by the cap) — re-open to In Progress with a fresh no-progress clock so it can use the
          // new headroom; the thread resumes on the next dispatch.
          dispatcher.stopRun(issue.id)
          state.progress.delete(issue.id)
          state.saveProgress()
          state.deadlocked.delete(issue.id) // BEV audit: a fresh no-progress clock must also clear first-offense memory, or the next deadlock skips QA-blocked triage and jumps straight to Factory - Needs Engineer
          state.saveDeadlocked()
          notesFetched.delete(issue.id)
          summaries.delete(issue.identifier)
          await moveIssue(getCfg(), issue.id, 'In Progress', mirror)
          dispatcher.scheduleRetry(issue.id, issue.identifier, 1, true)
          return { ok: true, msg: `+${Math.round(inc / 1e6)}M budget → re-opened to In Progress` }
        }
        return { ok: true, msg: `+${Math.round(inc / 1e6)}M budget (cap now ${Math.round(cap / 1e6)}M)` }
      }
      if (action === 'restart') {
        dispatcher.terminate(issue.id, false)
        removeWorkspace(getCfg(), issue.identifier, host)
        dispatcher.release(issue.id)
        state.threadRecs.delete(issue.id)
        state.saveThreads()
        state.logs.set(issue.identifier, []) // from-scratch run: clear the transcript too
        state.saveLogs()
        state.progress.delete(issue.id) // BEV audit: "fresh thread" must also mean a fresh no-progress clock and first-offense memory — otherwise a ticket that deadlocked once before the restart skips straight to Factory - Needs Engineer on its very next deadlock
        state.saveProgress()
        state.deadlocked.delete(issue.id)
        state.saveDeadlocked()
        log(`action: ${identifier} restart (operator, fresh thread)`)
        return { ok: true, msg: 'restarting fresh' }
      }
      if (action === 'cancel') {
        // Operator escape hatch: abandon the ticket and drop it off the board. Stop + tear down the run FIRST
        // (like restart), THEN move to Canceled — otherwise the still-running agent races the in-flight Linear
        // move and can keep writing Linear or even move the ticket back out of Canceled after the click.
        // removeWorkspace is unconditional (not terminate(_, true), which only wipes when the ticket is currently
        // running) so canceling an idle/parked ticket doesn't leak its workspace dir. If the move throws after
        // teardown, the ticket simply stays where it was, stopped — the poll re-dispatches or the operator retries.
        dispatcher.terminate(issue.id, false)
        removeWorkspace(getCfg(), issue.identifier, host)
        dispatcher.release(issue.id)
        state.threadRecs.delete(issue.id)
        state.saveThreads()
        state.progress.delete(issue.id)
        state.saveProgress()
        state.deadlocked.delete(issue.id)
        state.saveDeadlocked()
        await moveIssue(getCfg(), issue.id, 'Canceled', mirror)
        log(`action: ${identifier} canceled (operator) — moved to Canceled`)
        return { ok: true, msg: 'canceled — moved to Canceled' }
      }
      if (action === 'to-qa' || action === 'to-build') {
        const target = action === 'to-qa' ? 'QA - Testing' : 'In Progress'
        grantIfCapped(identifier, issue)
        dispatcher.stopRun(issue.id) // stop the current turn but keep the pin + workspace + thread → the move resumes it
        await moveIssue(getCfg(), issue.id, target, mirror)
        notesFetched.delete(issue.id)
        summaries.delete(issue.identifier)
        dispatcher.scheduleRetry(issue.id, issue.identifier, 1, true) // continuation: re-dispatch on the pinned worker, resuming
        log(`action: ${identifier} → ${target} (operator)`)
        return { ok: true, msg: `moved to ${target}` }
      }
      if (action.startsWith('move:')) {
        const target = action.slice('move:'.length)
        grantIfCapped(identifier, issue)
        dispatcher.stopRun(issue.id) // stop any current turn; keep pin + workspace + thread
        await moveIssue(getCfg(), issue.id, target, mirror)
        notesFetched.delete(issue.id)
        summaries.delete(issue.identifier)
        dispatcher.scheduleRetry(issue.id, issue.identifier, 1, true) // re-dispatch (resume) if the target is active; the poll idles/cleans up otherwise
        log(`action: ${identifier} → ${target} (operator move)`)
        return { ok: true, msg: `moved to ${target}` }
      }
      return { ok: false, msg: `unknown action: ${action}` }
    } catch (e) {
      return { ok: false, msg: e instanceof Error ? e.message : String(e) }
    }
  }

  return { onAction, setPaused }
}
