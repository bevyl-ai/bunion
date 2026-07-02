import { startAgent, type AgentHandle } from './agent-runner'
import { phaseOf } from './config'
import { log, warn } from './log'
import { fetchStatesByIds, moveIssue, postComment } from './linear'
import { isActive, isRoutable, isTerminal, norm, planBlocked } from './orchestrator-predicates'
import type { Placement } from './orchestrator-placement'
import type { PersistedState } from './orchestrator-state'
import type { Stats } from './stats'
import { foldDelta, grandTotal, resolveTokenBase, zeroCounts } from './tokens'
import { removeWorkspace } from './workspace'
import type { Config, Issue, RateLimits, TokenCounts } from './types'
import type { TrackerMirror } from './tracker-mirror'
import type { GithubMirror } from './github-mirror'

interface RunningEntry {
  issue: Issue
  handle: AgentHandle
  retryAttempt: number
  startedAt: number
  lastActivity: number
  turn: number
  activity: string
  host: string | null // the worker VM this run is pinned to (null = local)
  phase: string // the pipeline phase this session is running (tokens are attributed here)
  tokenBase: TokenCounts // last-folded thread-cumulative usage, so we add only the delta to the persistent tally
  turnId: string | null // latest codex turn id — composes session_id = `${threadId}-${turnId}` (§13.1 / §4.2)
}
interface RetryTimer {
  timer: ReturnType<typeof setTimeout>
  token: number
  identifier: string
  attempt: number
  dueAt: number
}

const CONTINUATION_MS = 1000
const FAILURE_BASE_MS = 10_000
// BEV-3969/3971: worker/workspace-infra failure classes — distinct from a normal mid-turn hiccup (turn_timeout,
// turn_failed). A single hit is ambiguous (cold VM, version skew, or the stale-workspace case ensureWorkspace now
// self-heals) so these still retry normally; only a STREAK on the same ticket (the self-heal didn't fix it — a
// dead/unreachable worker, codex crash-looping) is worth waking a human for.
const WORKER_SETUP_CODES = new Set(['invalid_workspace_cwd', 'response_timeout', 'port_exit'])
const WORKER_SETUP_STREAK_LIMIT = 3

export type Dispatcher = ReturnType<typeof createDispatcher>

// The core ticket-dispatch subsystem: claim → run a Codex worker → retry/continue/escalate on completion, plus
// reconcile() which polls Linear for tickets currently running to catch external state changes early. Owns
// running/claimed/retries and the placement pin lifecycle around them.
export function createDispatcher(getCfg: () => Config, state: PersistedState, placement: Placement, mirror: TrackerMirror, ghMirror: GithubMirror, stats: Stats, acct: (host: string | null) => string | null, livePartial: Map<string, string>, summaries: Map<string, string>, drainOperatorMsgs: (issueId: string) => () => string[]) {
  const running = new Map<string, RunningEntry>()
  const claimed = new Set<string>()
  const retries = new Map<string, RetryTimer>()
  // Tickets terminate()'d THIS tick by the stall-check or deadlock sweep, both of which release the claim
  // immediately but want a CONTROLLED re-entry (a scheduled retry 10s+ out, or simply "sit in the new state
  // until a later poll") — not the instant pickup they'd otherwise get. terminate() clears `claimed`/`running`
  // synchronously, and the main dispatch loop runs LATER in this SAME tick over a `board` snapshot that still
  // shows the ticket "active": without this guard it gets re-dispatched fresh (attempt 0) within the same tick,
  // silently discarding the backoff and resetting the retry counter every time — exactly what stall-retry's
  // "attempt" log kept showing as #1 forever instead of escalating, and what let a deadlocked ticket burn through
  // its whole token cap via tight restart-thrash instead of pausing in its triage state. Cleared at the top of
  // every tick so it never suppresses dispatch beyond the tick that caused it.
  const skipDispatchThisTick = new Set<string>()
  let tokenSeq = 0
  let endedRuntimeMs = 0 // cumulative wall-clock of ENDED sessions (§13.3) — live sessions are added at snapshot time via `running`
  let lastRateLimits: RateLimits | null = null // most recent codex rate-limit snapshot (Symphony §13.3 / §4.1.8)
  const setupFailureStreaks = new Map<string, number>() // BEV-3969/3971: consecutive WORKER_SETUP_CODES failures per ticket

  const eligible = (i: Issue): boolean =>
    isActive(getCfg(), i.state) && !isTerminal(getCfg(), i.state) && isRoutable(getCfg(), i) && !planBlocked(getCfg(), i) && !claimed.has(i.id) && !running.has(i.id)
  // Per-state concurrency (Symphony §8.2/§8.3): an issue in state S is dispatch-eligible only if fewer than
  // max_concurrent_agents_by_state[S] agents are already running on issues in S (counted by their CURRENT state). No
  // entry for S = no per-state limit (the global cap is the only ceiling). Bounds an expensive stage's blast radius —
  // one phase (e.g. the blocked phase on `QA - blocked`) can't consume every slot.
  const stateFull = (state: string): boolean => {
    const cap = getCfg().agent.maxConcurrentByState[norm(state)]
    if (cap === undefined) return false
    let n = 0
    for (const e of running.values()) if (norm(e.issue.state) === norm(state)) n++
    return n >= cap
  }
  const slots = (): number => Math.max(getCfg().agent.maxConcurrentAgents - running.size, 0)

  const clearRetry = (id: string): void => {
    const r = retries.get(id)
    if (r) {
      clearTimeout(r.timer)
      retries.delete(id)
    }
  }
  const release = (id: string): void => {
    claimed.delete(id)
    clearRetry(id)
    placement.freePlacement(id)
  }
  // Stop a ticket's running session but KEEP its pin + workspace + thread, so a follow-up dispatch resumes it on the
  // same worker (the operator-transition path). terminate() additionally releases the pin (and optionally wipes).
  const stopRun = (id: string): void => {
    const e = running.get(id)
    if (e) {
      e.handle.stop()
      running.delete(id)
    }
    claimed.delete(id)
    clearRetry(id)
  }
  const terminate = (id: string, cleanup: boolean): void => {
    const e = running.get(id)
    const host = placement.placement.get(id) ?? null
    stopRun(id)
    placement.freePlacement(id)
    if (cleanup && e) removeWorkspace(getCfg(), e.issue.identifier, host)
  }

  const retryDelay = (attempt: number, continuation: boolean): number =>
    continuation && attempt === 1 ? CONTINUATION_MS : Math.min(FAILURE_BASE_MS * 2 ** Math.min(attempt - 1, 10), getCfg().agent.maxRetryBackoffMs)

  const scheduleRetry = (id: string, identifier: string, attempt: number, continuation: boolean): void => {
    clearRetry(id)
    const delay = retryDelay(attempt, continuation)
    const token = ++tokenSeq
    const timer = setTimeout(() => void onRetry(id, identifier, attempt, token), delay)
    retries.set(id, { timer, token, identifier, attempt, dueAt: Date.now() + delay })
  }

  const dispatch = (issue: Issue, attempt: number, host: string | null): void => {
    const cfg = getCfg()
    clearRetry(issue.id)
    claimed.add(issue.id)
    placement.claim(issue.id, host)
    state.touchLog(issue.identifier)
    // BEV audit: codex reports THREAD-cumulative tokens; a genuinely fresh thread starts near 0, but a session that
    // RESUMES an existing thread reports the full history-to-date on its very first turn. tokenBase seeds from the
    // resumed thread's last-folded total (below, once we know the actual thread id matches) so foldDelta computes
    // this session's real spend, not the whole thread re-added on top of the tally that already has it.
    const resumingThreadId = state.threadRecs.get(issue.id)?.threadId ?? null
    const priorTokenBase = state.threadRecs.get(issue.id)?.lastTokenBase ?? null
    let tokenBaseSeeded = false
    const entry: RunningEntry = { issue, handle: undefined as unknown as AgentHandle, retryAttempt: attempt > 0 ? attempt : 0, startedAt: Date.now(), lastActivity: Date.now(), turn: 0, activity: 'starting…', host, phase: phaseOf(cfg, issue.state), tokenBase: zeroCounts(), turnId: null }
    running.set(issue.id, entry)
    // §13.1: session_id = `${threadId}-${turnId}` when both known; threadId alone until first turn id arrives
    const sessionId = (): string => { const t = state.threadRecs.get(issue.id)?.threadId; return t ? `${t}${entry.turnId ? `-${entry.turnId}` : ''}` : '' }
    log(`→ ${issue.identifier} (${issue.state})${attempt > 0 ? ` retry#${attempt}` : ''}${host ? ` @ ${host}` : ''}`)
    stats.record({ identifier: issue.identifier, kind: 'dispatch', threadId: state.threadRecs.get(issue.id)?.threadId, host, totalTokens: grandTotal(state.tokens, issue.identifier), account: acct(host) })
    entry.handle = startAgent(cfg, issue, attempt > 0 ? attempt : null, host, (e) => {
      entry.lastActivity = Date.now()
      if (e.turn != null) entry.turn = e.turn
      if (e.label != null) entry.activity = e.label
      if (e.turnId) entry.turnId = e.turnId // §13.1: track latest turn id for session_id composition
      if (e.threadId) {
        if (!tokenBaseSeeded) {
          tokenBaseSeeded = true
          entry.tokenBase = resolveTokenBase(e.threadId, resumingThreadId, priorTokenBase)
        }
        state.threadRecs.set(issue.id, { threadId: e.threadId, host, lastTokenBase: entry.tokenBase })
        state.saveThreads()
      }
      if (e.stream != null) livePartial.set(issue.identifier, e.stream)
      if (e.log != null) {
        if (e.log.startsWith('● ')) livePartial.delete(issue.identifier) // the message committed → clear the live partial
        const arr = state.logs.get(issue.identifier)
        if (arr) {
          arr.push(e.log)
          if (arr.length > 600) arr.splice(0, arr.length - 600)
          state.saveLogs()
        }
        if (e.log.startsWith('● ')) summaries.set(issue.identifier, e.log.slice(2, 400)) // keep the latest agent message
      }
      if (e.tokens) {
        // codex sends the thread-cumulative total each turn; fold the delta into this ticket's phase tally.
        const acc = ((state.tokens[issue.identifier] ??= {})[entry.phase] ??= zeroCounts())
        foldDelta(acc, e.tokens, entry.tokenBase)
        entry.tokenBase = e.tokens
        state.saveTokens()
        const rec = state.threadRecs.get(issue.id)
        if (rec) { state.threadRecs.set(issue.id, { ...rec, lastTokenBase: e.tokens }); state.saveThreads() } // keep the persisted seed current turn-by-turn, not just at thread-start
      }
      if (e.rateLimits) lastRateLimits = e.rateLimits // newest coding-agent rate-limit snapshot for the dashboard
    }, state.threadRecs.get(issue.id)?.threadId ?? null, { tracker: mirror, github: ghMirror }, drainOperatorMsgs(issue.id))
    void entry.handle.done.then(async (outcome) => {
      if (running.get(issue.id) !== entry) return // already terminated by reconcile
      running.delete(issue.id)
      endedRuntimeMs += Date.now() - entry.startedAt // fold this session's wall-clock into the aggregate runtime (§13.3)
      const sid = sessionId()
      if (outcome.ok) {
        setupFailureStreaks.delete(issue.id)
        scheduleRetry(issue.id, issue.identifier, 1, true) // re-check & continue while active
        log(`✓ ${issue.identifier} session done${sid ? ` session=${sid}` : ''}`) // §13.1
        stats.record({ identifier: issue.identifier, kind: 'session_done', threadId: state.threadRecs.get(issue.id)?.threadId, host: entry.host, totalTokens: grandTotal(state.tokens, issue.identifier), account: acct(entry.host) })
      } else {
        const code = outcome.code
        // §10.6: a genuinely-missing codex binary is non-transient — retrying forever won't fix it; route to Needs
        // human so an operator can diagnose. A WORKER_SETUP_CODES hit is individually ambiguous (cold VM, version
        // skew, or a stale workspace ensureWorkspace now self-heals) so it retries normally — UNLESS it's now the
        // Nth in a row on this same ticket, meaning the self-heal didn't fix it either.
        const isWorkerSetupCode = !!code && WORKER_SETUP_CODES.has(code)
        const streak = isWorkerSetupCode ? (setupFailureStreaks.get(issue.id) ?? 0) + 1 : 0
        if (isWorkerSetupCode) setupFailureStreaks.set(issue.id, streak)
        else setupFailureStreaks.delete(issue.id)
        const isSetupFailure = code === 'codex_not_found' || streak >= WORKER_SETUP_STREAK_LIMIT
        warn(`✗ ${issue.identifier}: ${(outcome.error ?? '').slice(0, 200)}${sid ? ` session=${sid}` : ''}${code ? ` code=${code}` : ''}${streak > 1 ? ` streak=${streak}` : ''}`) // §13.1
        if (isSetupFailure) {
          log(`setup failure ${issue.identifier} (${code}${streak > 1 ? ` x${streak}` : ''}) → Factory - Needs Engineer`)
          try {
            await moveIssue(cfg, issue.id, 'Factory - Needs Engineer', mirror)
            await postComment(cfg, issue.id, `## ⚠️ Setup failure — needs operator\nThe factory cannot run this ticket: \`${code}\`${streak >= WORKER_SETUP_STREAK_LIMIT ? ` (${streak} consecutive worker-setup failures — recreating the workspace did not resolve it)` : ''}.\n\n> ${(outcome.error ?? '').slice(0, 400)}\n\nManual intervention required before it can retry.`, mirror)
          } catch (e) {
            warn(`setup failure move ${issue.identifier}: ${e instanceof Error ? e.message : String(e)}`)
          }
          setupFailureStreaks.delete(issue.id)
          release(issue.id) // release the claim/pin AFTER the move lands, so the next poll can't re-dispatch it mid-move
        } else {
          const next = entry.retryAttempt > 0 ? entry.retryAttempt + 1 : 1
          scheduleRetry(issue.id, issue.identifier, next, false)
        }
      }
    })
  }

  async function onRetry(id: string, identifier: string, attempt: number, token: number): Promise<void> {
    if (retries.get(id)?.token !== token) return // superseded
    retries.delete(id)
    if (state.paused) {
      claimed.delete(id) // panic switch: drop the claim (keep the pin, like stopRun) so the main loop re-dispatches on resume
      return
    }
    // The mirror is the same freshness the main dispatch loop acts on — no network read needed here.
    const issue = mirror.getIssue(id)
    if (!issue) return release(id)
    if (isTerminal(getCfg(), issue.state)) {
      removeWorkspace(getCfg(), issue.identifier, placement.placement.get(id) ?? null)
      return release(id)
    }
    if (!eligible(issue)) return release(id)
    if (slots() <= 0 || stateFull(issue.state)) return scheduleRetry(id, identifier, attempt + 1, false)
    const host = placement.placeFor(id) // a continuation reuses its pinned VM; a fresh retry takes any free worker
    if (host === undefined) return scheduleRetry(id, identifier, attempt + 1, false)
    dispatch(issue, attempt, host)
  }

  async function reconcile(): Promise<void> {
    const cfg = getCfg()
    if (cfg.codex.stallTimeoutMs > 0) {
      const now = Date.now()
      for (const [id, e] of running) { // safe: terminate() deletes exactly the entry being visited, which Map iterators handle correctly without a snapshot
        if (now - e.lastActivity > cfg.codex.stallTimeoutMs) {
          const next = e.retryAttempt > 0 ? e.retryAttempt + 1 : 1
          terminate(id, false)
          skipDispatchThisTick.add(id) // scheduleRetry owns re-entry now — don't let this tick's dispatch loop grab it first
          scheduleRetry(id, e.issue.identifier, next, false)
          warn(`stalled ${e.issue.identifier} → retry#${next}`)
        }
      }
    }
    const ids = [...running.keys()]
    if (ids.length === 0) return
    let refreshed: Issue[]
    try {
      refreshed = await fetchStatesByIds(cfg, ids)
    } catch {
      return
    }
    const seen = new Set(refreshed.map((i) => i.id))
    for (const i of refreshed) {
      if (!running.has(i.id)) continue
      if (isTerminal(cfg, i.state)) terminate(i.id, true)
      else if (!isRoutable(cfg, i)) terminate(i.id, false)
      else if (isActive(cfg, i.state)) running.get(i.id)!.issue = i
      else terminate(i.id, false)
    }
    for (const id of ids) if (!seen.has(id) && running.has(id)) terminate(id, false)
  }

  return { running, claimed, retries, skipDispatchThisTick, setupFailureStreaks, eligible, stateFull, slots, release, stopRun, terminate, scheduleRetry, dispatch, onRetry, reconcile, getEndedRuntimeMs: () => endedRuntimeMs, getLastRateLimits: () => lastRateLimits }
}
