import { join } from 'node:path'
import { GithubMirror } from './github-mirror'
import { sweepBoardPrs } from './github-sync'
import { TrackerMirror } from './tracker-mirror'
import { auditMirror, boardFromMirror, drainWrites, syncMirror } from './tracker-sync'
import { loadConfig, validateConfig } from './config'
import { startDashboard } from './dashboard'
import { fetchLatestNote, moveIssue, noteFromComments, postComment, recentAuthFailures } from './linear'
import { log, warn } from './log'
import { flushAllPending } from './persist'
import { sshExec } from './ssh'
import { backfillThreads } from './thread-backfill'
import { grandTotal } from './tokens'
import { openStats } from './stats'
import { createChat } from './orchestrator-chat'
import { createDispatcher } from './orchestrator-dispatch'
import { createActions } from './orchestrator-actions'
import { trackProgress } from './orchestrator-deadlock'
import { createPlacement } from './orchestrator-placement'
import { isActive, isRoutable, isTerminal, norm, planBlocked } from './orchestrator-predicates'
import { pruneWorkspaces } from './orchestrator-prune'
import { createRolePool } from './orchestrator-roles'
import { createPersistedState, STATE_DIR } from './orchestrator-state'
import { createSnapshot } from './orchestrator-snapshot'
import type { Config, Issue } from './types'

// The thin harness. Poll the tracker's active states, dispatch a Codex worker per issue (bounded), reconcile
// running issues against the tracker, and retry. It never touches Linear state or git for the normal flow — the
// AGENT does, via the workflow prompt + skills; the host's only writes are operator actions and deadlock moves.
//
// Composition root: wires together the extracted subsystems (state persistence, placement, dispatch, deadlock
// tracking, roles, chat, actions, snapshot, workspace pruning) and runs the poll loop that drives them.
export async function start(workflowPath?: string): Promise<void> {
  // Unattended daemon: a stray rejection (flaky VM, transient API error) must never take the whole factory down.
  process.on('unhandledRejection', (e) => warn(`unhandled rejection: ${e instanceof Error ? e.message : String(e)}`))
  // BEV re-audit: systemd sends SIGTERM on every `systemctl restart`/`stop` — force every debounced throttledWriter
  // out to disk before exiting, so a restart inside the up-to-3s coalescing window can never silently lose the
  // most recent write.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => { flushAllPending(); process.exit(0) })
  }
  let cfg = loadConfig(workflowPath)
  validateConfig(cfg)
  const getCfg = (): Config => cfg
  log(`default repo ${cfg.repo}${Object.keys(cfg.repos).length ? ` (+${Object.keys(cfg.repos).length} more via repo:<slug> labels)` : ` (repos:{} — route others with a repo:<slug> label)`}`)

  let lastBoard: Issue[] = [] // every non-terminal labeled ticket from the last poll — the whole board, not just running
  const getLastBoard = (): Issue[] => lastBoard

  const state = createPersistedState(getCfg, getLastBoard)
  const placement = createPlacement(getCfg, state.threadRecs)
  const mirror = new TrackerMirror(join(STATE_DIR, 'mirror.db')) // the tracker spine: durable local mirror + write queue (tracker-mirror.ts); agents/dispatch/dashboard read here, not Linear
  const ghMirror = new GithubMirror(join(STATE_DIR, 'mirror.db')) // its GitHub twin: PR snapshots for the build gate + pit freshness (github-mirror.ts)
  const stats = openStats() // local bun:sqlite stats/rollups (~/.bunion/stats.db) — best-effort event log, never throws

  const livePartial = new Map<string, string>() // identifier → the agent's CURRENTLY-streaming reply text (ephemeral; cleared when the message commits as a `● ` log line)
  const summaries = new Map<string, string>() // last agent message per ticket — survives the log buffer, surfaces the human action
  const notesFetched = new Set<string>() // stuck tickets whose verdict comment we've pulled once for display
  const lastState = new Map<string, string>() // last-seen Linear state per ticket — drops a stale note on transition
  const gatewayHost = new Map<string, string>() // worker host → its codex base_url's llm-integration hostname (resolved once; display-only LLM-account tracking)
  let backfilled = false // one-shot: recover unknown threads from worker rollouts on the first board
  // BEV-4025: poll health, surfaced on the dashboard — a Linear poll failure used to only `warn()` to the daemon log
  // (operator-invisible) and silently keep `lastBoard` stale forever with no on-screen signal it was happening.
  let pollFailureStreak = 0
  let lastPollError: string | null = null
  let lastPollOkAt: number | null = null

  const acct = (h: string | null): string | null => { if (!h) return null; const gw = gatewayHost.get(h); return gw ? (cfg.worker.gatewayAccounts[gw] ?? gw) : null }

  const roles = createRolePool(getCfg, state, placement, () => state.paused, getLastBoard)
  const dispatcher = createDispatcher(getCfg, state, placement, mirror, ghMirror, stats, acct, livePartial, summaries, (issueId) => chat.drainPending(issueId))
  const chat = createChat(getCfg, state, placement, mirror, livePartial, (name) => roles.roleRunning.has(name), (id) => dispatcher.running.has(id), getLastBoard, cfg.roles)
  const actions = createActions(getCfg, state, placement, dispatcher, roles, mirror, summaries, notesFetched, getLastBoard)
  const snapshot = createSnapshot(getCfg, state, placement, dispatcher, roles, summaries, getLastBoard, gatewayHost, () => ({ failureStreak: pollFailureStreak, lastError: lastPollError, lastOkAt: lastPollOkAt }))

  // Recover threads from worker rollouts for tickets bunion has no record of, then persist what was found. Runs
  // once on the first board; makes a pre-persistence handoff chattable.
  const runBackfill = async (board: Issue[]): Promise<void> => {
    const found = await backfillThreads(board, placement.hosts(), (id) => state.threadRecs.has(id))
    let n = 0
    for (const [id, rec] of found)
      if (!state.threadRecs.has(id)) {
        state.threadRecs.set(id, rec)
        n++
      }
    if (n > 0) {
      state.saveThreads()
      log(`backfilled ${n} ticket thread(s) from worker rollouts`)
    }
  }

  const workerDesc = placement.hosts().length === 0 ? 'local' : `${placement.hosts().length} VM${placement.hosts().length > 1 ? 's' : ''}×${cfg.worker.maxPerHost}`
  log(`bunion up · scope=${cfg.tracker.team ?? cfg.tracker.projectSlug}${cfg.tracker.requiredLabels.length ? ` [${cfg.tracker.requiredLabels.join(',')}]` : ''} · cap=${placement.displayCap(cfg.agent.maxConcurrentAgents)} · workers=${workerDesc} · poll=${cfg.pollIntervalMs}ms`)

  if (cfg.dashboardPort) void startDashboard(cfg.dashboardPort, snapshot, state.getLog, log, actions.onAction, chat.onChat, stats, (id) => livePartial.get(id) ?? '')

  // Start the pool — each role on its cadence. BEV audit: roleLast is persisted, so the FIRST run after a restart
  // waits out whatever's left of the role's real cadence instead of always firing within the first minute,
  // regardless of how recently it actually ran. A role that's genuinely never run (or is already overdue) still
  // gets a short stagger so roles don't all fire on the same tick. (Role config is read at start; add/edit roles then restart.)
  cfg.roles.forEach((role, i) => {
    const tick = (): void => roles.dispatchRole(role, i)
    setInterval(tick, role.cadenceMs)
    const last = state.roleLast.get(role.name)
    const stagger = 10_000 + i * 20_000
    const initialDelay = last != null ? Math.max(i * 2_000, role.cadenceMs - (Date.now() - last)) : stagger
    setTimeout(tick, initialDelay)
  })

  // Periodic workspace hygiene: each ticket's checkout is ~5-6G (node_modules + git history), and stale ones pile
  // up as tickets cycle across VMs (every restart re-pins and orphans the old copy). Fire-and-forget; never blocks the loop.
  const sweepWorkspaces = (): void => {
    const hosts = placement.hosts()
    if (hosts.length === 0) return
    const pinned: Array<{ identifier: string; host: string }> = []
    for (const e of dispatcher.running.values()) if (e.host) pinned.push({ identifier: e.issue.identifier, host: e.host })
    for (const [id, r] of dispatcher.retries) {
      const h = placement.placement.get(id)
      if (h) pinned.push({ identifier: r.identifier, host: h })
    }
    // After a restart running/retries/placement are all empty (in-memory only) — but threadRecs.host is PERSISTED
    // and already used elsewhere to land a resume back on the worker holding the rollout, so it reliably tells us
    // where a ticket's workspace actually lives even across a restart. Only tickets we genuinely have no host
    // record for (never dispatched, or pre-date host tracking) get the broad protect-everywhere fallback.
    const board = lastBoard.map((i) => ({ identifier: i.identifier, host: placement.placement.get(i.id) ?? state.threadRecs.get(i.id)?.host ?? null }))
    // BEV-4061: pool roles keep ONE persistent checkout each (`role-<name>`), reused across cadence runs — it must
    // survive between (and especially DURING) runs, or the mechanic's next pass starts from a vanished cwd.
    const roleWs = cfg.roles.map((r) => ({ name: r.name, host: roles.roleRunning.get(r.name)?.host ?? state.threadRecs.get(`role:${r.name}`)?.host ?? null }))
    pruneWorkspaces(hosts, pinned, board, roleWs)
  }
  if (cfg.worker.sshHosts.length) {
    setInterval(sweepWorkspaces, 20 * 60 * 1000)
    // The first sweep runs from the once-on-first-board block below (after lastBoard is populated), NOT immediately — an
    // immediate sweep on a fresh restart has empty running/retries + board, so it would delete in-flight dirs and race re-dispatch.
  }

  for (;;) {
    try {
      // Reload at the top so reconcile + dispatch both see the same fresh config; keep last-known-good on a bad edit
      // (never skip reconcile because of a config error).
      try {
        const next = loadConfig(workflowPath)
        validateConfig(next)
        cfg = next
      } catch (e) {
        warn(`config: ${e instanceof Error ? e.message : e} (keeping last good)`)
      }
      // Linear auth-failure circuit breaker: if the agents are hammering a dead/blocked token (repeated 401s), AUTO-PAUSE
      // so we stop before Linear revokes us (again). Resume after restoring the token.
      if (!state.paused && recentAuthFailures(60_000) >= 12) {
        actions.setPaused(true)
        warn('Linear auth failing repeatedly (likely a dead/blocked token) — AUTO-PAUSED to stop hammering; fix the token, then resume')
      }
      dispatcher.skipDispatchThisTick.clear() // fresh for this tick — see its declaration for why it exists
      await dispatcher.reconcile()
      let board: Issue[]
      try {
        // Delta-sync the mirror (usually two tiny requests), then compute the board locally. isRoutable is the
        // single owner of the label/delegation opt-in.
        await syncMirror(cfg, mirror, warn)
        board = boardFromMirror(mirror).filter((i) => isRoutable(cfg, i))
        pollFailureStreak = 0
        lastPollError = null
        lastPollOkAt = Date.now()
        await drainWrites(cfg, mirror, warn) // durable orchestrator writes (deadlock moves, sweep comments) retry here
        await auditMirror(cfg, mirror, warn).catch((e) => warn(`mirror audit failed: ${e instanceof Error ? e.message : String(e)}`))
        await sweepBoardPrs(cfg, ghMirror, board, warn) // keep board-attached PR snapshots fresh (per-PR errors logged inside)
      } catch (e) {
        pollFailureStreak++
        lastPollError = e instanceof Error ? e.message : String(e)
        warn(`poll: ${lastPollError}${pollFailureStreak > 1 ? ` (streak ${pollFailureStreak})` : ''}`)
        await sleep(cfg.pollIntervalMs)
        continue
      }
      lastBoard = board
      // Resolve one worker's LLM-gateway hostname per poll (cached for the daemon's life) → display-only account tracking.
      const unresolvedHost = placement.hosts().find((h) => !gatewayHost.has(h))
      if (unresolvedHost) {
        const gw = sshExec(unresolvedHost, 'grep base_url "$HOME/.codex/config.toml"', 6000)
        const m = gw.ok ? /llm[0-9-]*\.int\.exe\.xyz/.exec(gw.out) : null
        gatewayHost.set(unresolvedHost, m ? m[0] : '')
      }
      if (!backfilled) {
        backfilled = true
        void runBackfill(board)
        sweepWorkspaces() // §8.6: first sweep now that the board is known, so in-flight workspaces are protected
      }
      // Surface WHY a ticket is stuck: pull its workpad Verdict for the blocked + needs-human states (not while an
      // agent is live on it — its own messages fill the note then). Clear a cached note when a ticket changes state
      // so a qa-blocked verdict doesn't linger after the blocked phase escalates it to Factory - Needs Engineer.
      const now = Date.now()
      const stuck: { issue: Issue; target: string; reason: string }[] = []
      for (const i of board) {
        if (lastState.get(i.id) !== i.state) {
          const prev = lastState.get(i.id)
          lastState.set(i.id, i.state)
          summaries.delete(i.identifier)
          notesFetched.delete(i.id)
          // Record the state transition (skip first-sight / restart re-observations — only real changes from a known prior state).
          if (prev !== undefined) stats.record({ identifier: i.identifier, kind: 'transition', fromState: prev, toState: i.state, threadId: state.threadRecs.get(i.id)?.threadId, totalTokens: grandTotal(state.tokens, i.identifier), account: acct(placement.placement.get(i.id) ?? null), host: placement.placement.get(i.id) ?? null })
        }
        const pr = state.progress.get(i.id) ?? { since: now, tokensAtProgress: grandTotal(state.tokens, i.identifier), seen: new Set<string>() }
        state.progress.set(i.id, pr)
        const total = grandTotal(state.tokens, i.identifier)
        const stuckTicket = trackProgress(i, now, pr, (s) => isActive(cfg, s), (s) => isTerminal(cfg, s), planBlocked(cfg, i), total, state.effectiveCap(i.identifier), cfg.deadlock, state.deadlocked.has(i.id))
        state.saveProgress()
        if (stuckTicket) stuck.push(stuckTicket)
        const s = norm(i.state)
        // Hydrate the human-facing note (latest Codex Workpad) for every lane a person acts on, so the card shows
        // the reason (why blocked / what to decide / the prod check to run / QA proof) even after the transient
        // transcript is evicted. Covers the escalations + all the human-review gates.
        if ((s === 'qa - blocked' || s === 'factory - needs engineer' || s === 'stg - ready to merge' || s === 'qa - requested' || s === 'factory - ui review' || s === "factory - can't verify") && !dispatcher.running.has(i.id) && !summaries.has(i.identifier) && !notesFetched.has(i.id)) {
          notesFetched.add(i.id)
          const thread = mirror.getComments(i.id)
          const note = thread ? noteFromComments(thread.map((c) => c.body)) : null
          if (note) summaries.set(i.identifier, note)
          else void fetchLatestNote(cfg, i.id).then((n) => n && summaries.set(i.identifier, n)).catch(() => {})
        }
      }
      for (const id of [...state.progress.keys()]) if (!board.some((i) => i.id === id)) { state.progress.delete(id); state.deadlocked.delete(id); dispatcher.setupFailureStreaks.delete(id) }
      state.saveProgress()
      state.saveDeadlocked()
      // Deadlock sweep: no forward progress + resource burn → move to the blocked state (the blocked phase triages it),
      // or to Factory - Needs Engineer if it already deadlocked once. skipDispatchThisTick is what ACTUALLY keeps it
      // from being re-dispatched below this poll — awaiting the move alone doesn't (terminate() already released the
      // claim above, and the dispatch loop's board snapshot still shows the mutated `target` state as active).
      for (const { issue, target, reason } of stuck) {
        state.deadlocked.add(issue.id)
        state.saveDeadlocked()
        dispatcher.terminate(issue.id, false)
        dispatcher.skipDispatchThisTick.add(issue.id)
        state.progress.delete(issue.id)
        state.saveProgress()
        lastState.set(issue.id, target)
        issue.state = target
        log(`deadlock: ${issue.identifier} ${reason} → ${target}`)
        stats.record({ identifier: issue.identifier, kind: reason.includes('per-ticket cap') ? 'cap' : 'deadlock', toState: target, threadId: state.threadRecs.get(issue.id)?.threadId, totalTokens: grandTotal(state.tokens, issue.identifier), account: acct(placement.placement.get(issue.id) ?? null), detail: reason })
        try {
          await moveIssue(cfg, issue.id, target, mirror)
          await postComment(cfg, issue.id, `## 🔁 Auto-blocked — deadlock\nThe factory ${reason} on this ticket, so I moved it to \`${target}\` instead of looping further.${target === 'QA - blocked' ? '\n\n**Blocked phase:** if there is no concrete, fixable meta-problem here, escalate to `Factory - Needs Engineer` — do not just send it back to loop again.' : ''}`, mirror)
        } catch (e) {
          warn(`deadlock move ${issue.identifier}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (!state.paused && dispatcher.slots() > 0) {
        for (const issue of board.filter((i) => isActive(cfg, i.state)).sort(byDispatch)) {
          if (dispatcher.slots() <= 0) break
          if (dispatcher.skipDispatchThisTick.has(issue.id)) continue // just terminate()'d this tick — let scheduleRetry/next poll own its re-entry
          if (!dispatcher.eligible(issue)) continue
          if (dispatcher.stateFull(issue.state)) continue // per-state concurrency cap reached — skip; this issue retries next poll
          const host = placement.placeFor(issue.id)
          if (host === undefined) continue // every worker VM is full — try this issue again next poll
          dispatcher.dispatch(issue, 0, host)
        }
      }
    } catch (e) {
      warn(`tick: ${e instanceof Error ? e.message : e}`)
    }
    await sleep(cfg.pollIntervalMs)
  }
}

// Symphony dispatch order: priority (urgent→low, none last), then oldest, then identifier.
function byDispatch(a: Issue, b: Issue): number {
  return rank(a.priority) - rank(b.priority) || (a.createdAt || '9999').localeCompare(b.createdAt || '9999') || (a.identifier || a.id).localeCompare(b.identifier || b.id)
}
function rank(p: number): number {
  return p >= 1 && p <= 4 ? p : 5
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
