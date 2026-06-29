import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startAgent, type AgentHandle } from './agent-runner'
import { startRole, type RoleHandle } from './role-runner'
import { AppServerSession } from './codex/app-server'
import { linearGraphqlTool, linearReadTool } from './codex/dynamic-tool'
import { loadConfig, phaseOf, validateConfig } from './config'
import { startDashboard, type BoardItem, type Snapshot } from './dashboard'
import { fetchBoard, fetchCandidates, fetchLatestNote, fetchStatesByIds, moveIssue, postComment, recentAuthFailures } from './linear'
import { log, recentLogs, warn } from './log'
import { readJson, throttledWriter, writeJson } from './persist'
import { remoteHome, sshExec } from './ssh'
import { backfillThreads } from './thread-backfill'
import { foldDelta, grandTotal, phaseBreakdown, totals, zeroCounts, type TokenTally } from './tokens'
import { openStats } from './stats'
import { removeWorkspace } from './workspace'
import type { Config, Issue, RateLimits, Role, RoleQuota, TokenCounts } from './types'

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
interface RoleEntry {
  handle: RoleHandle
  activity: string
  host: string | null
  tokenBase: TokenCounts
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
const LOG_TICKETS = 60 // most-recent tickets whose transcript we keep in memory + persist
const STATE_DIR = join(homedir(), '.bunion')
const TOKENS_FILE = join(STATE_DIR, 'tokens.json') // identifier → phase → token counts
const LOGS_FILE = join(STATE_DIR, 'logs.json') // identifier → recent transcript lines
const THREADS_FILE = join(STATE_DIR, 'threads.json') // issue.id / role:<name> → { threadId, host }
const QUOTA_FILE = join(STATE_DIR, 'role-quota.json') // role name → { day, count } — daily ticket-filing cap, persisted
const GRANTS_FILE = join(STATE_DIR, 'ticket-grants.json') // identifier → extra token budget granted on top of the hard cap, persisted
const PAUSED_FILE = join(STATE_DIR, 'paused.json') // operator panic switch — { paused: bool }, persisted so a restart mid-incident stays paused
const ROLE_PAUSED_FILE = join(STATE_DIR, 'role-paused.json') // per-role pause — [name,…] poolers stopped independently of the global pause, persisted

// One codex thread per ticket / role, persisted (key → thread id + the worker holding its rollout) so the next
// phase and operator chat resume the same conversation, and a resume lands on the right worker after a restart.
interface ThreadRec {
  threadId: string
  host: string | null
}
// A role's daily ticket-filing counter, persisted (role name → { day, count }) so the cap survives the frequent
// daemon restarts. `day` is a UTC date string, so the count resets at UTC midnight.
interface QuotaRec {
  day: string
  count: number
  granted?: number // operator top-up for `day` — adds to the cap on demand; resets with the day like count
}
function utcDay(): string {
  return new Date().toISOString().slice(0, 10)
}

// The thin harness. Poll the tracker's active states, dispatch a Codex worker per issue (bounded), reconcile
// running issues against the tracker, and retry. It never touches Linear state or git for the normal flow — the
// AGENT does, via the workflow prompt + skills; the host's only writes are operator actions and deadlock moves.
export async function start(workflowPath?: string): Promise<void> {
  // Unattended daemon: a stray rejection (flaky VM, transient API error) must never take the whole factory down.
  process.on('unhandledRejection', (e) => warn(`unhandled rejection: ${e instanceof Error ? e.message : String(e)}`))
  let cfg = loadConfig(workflowPath)
  validateConfig(cfg)
  log(`default repo ${cfg.repo}${Object.keys(cfg.repos).length ? ` (+${Object.keys(cfg.repos).length} more via repo:<slug> labels)` : ` (repos:{} — route others with a repo:<slug> label)`}`)

  const running = new Map<string, RunningEntry>()
  const pendingChat = new Map<string, string[]>() // issueId → operator msgs queued while the agent was mid-turn; drained into the next continuation turn
  const claimed = new Set<string>()
  const retries = new Map<string, RetryTimer>()
  let lastBoard: Issue[] = [] // every non-terminal labeled ticket from the last poll — the whole board, not just running
  const gatewayHost = new Map<string, string>() // worker host → its codex base_url's llm-integration hostname (resolved once; display-only LLM-account tracking)
  let tokenSeq = 0
  let lastRateLimits: RateLimits | null = null // most recent codex rate-limit snapshot (Symphony §13.3 / §4.1.8)
  let endedRuntimeMs = 0 // cumulative wall-clock of ended sessions; live sessions are added at snapshot time
  // Operator panic switch — when paused, NOTHING dispatches (pipeline or roles) and running agents are halted, but the
  // daemon + dashboard stay up so you can watch + resume. Persisted, so a restart mid-incident does NOT un-pause.
  let paused = readJson<{ paused: boolean }>(PAUSED_FILE, { paused: false }).paused
  const savePaused = (v: boolean): void => writeJson(PAUSED_FILE, { paused: v })
  const rolePaused = new Set<string>(readJson<string[]>(ROLE_PAUSED_FILE, [])) // pool roles the operator has individually paused
  const saveRolePaused = (): void => writeJson(ROLE_PAUSED_FILE, [...rolePaused])

  // Persistent state under ~/.bunion, loaded once and re-saved (coalesced) as it changes, so numbers + transcripts
  // survive a daemon restart. `get` is read at write time, so callers just mutate then call save*().
  const logs = new Map<string, string[]>(Object.entries(readJson<Record<string, string[]>>(LOGS_FILE, {})).filter(([, a]) => Array.isArray(a)))
  const threadRecs = new Map<string, ThreadRec>(Object.entries(readJson<Record<string, ThreadRec>>(THREADS_FILE, {})))
  const tokens = readJson<TokenTally>(TOKENS_FILE, {}) // identifier → phase → cumulative token counts
  const saveLogs = throttledWriter(LOGS_FILE, () => Object.fromEntries(logs))
  const saveThreads = throttledWriter(THREADS_FILE, () => Object.fromEntries(threadRecs))
  const saveTokens = throttledWriter(TOKENS_FILE, () => tokens)
  let backfilled = false // one-shot: recover unknown threads from worker rollouts on the first board
  const roleRunning = new Map<string, RoleEntry>() // role name → its current run (the pool — ambient agents)
  const roleLast = new Map<string, number>() // role name → last completed run (ms)
  const roleQuota = new Map<string, QuotaRec>(Object.entries(readJson<Record<string, QuotaRec>>(QUOTA_FILE, {})))
  const saveQuota = throttledWriter(QUOTA_FILE, () => Object.fromEntries(roleQuota))
  // Per-ticket token-budget grants (identifier → extra tokens on top of deadlock.hardTokenCap), persisted. The operator
  // "bumps" a capped ticket to give it more headroom WITHOUT erasing its cumulative spend; effectiveCap folds it in.
  const ticketGrants = new Map<string, number>(Object.entries(readJson<Record<string, number>>(GRANTS_FILE, {})))
  const saveGrants = throttledWriter(GRANTS_FILE, () => Object.fromEntries(ticketGrants))
  const effectiveCap = (identifier: string): number => cfg.deadlock.hardTokenCap + (ticketGrants.get(identifier) ?? 0)
  const stats = openStats() // local bun:sqlite stats/rollups (~/.bunion/stats.db) — best-effort event log, never throws
  const acct = (h: string | null): string | null => { if (!h) return null; const gw = gatewayHost.get(h); return gw ? (cfg.worker.gatewayAccounts[gw] ?? gw) : null }
  const countToday = (name: string): number => {
    const r = roleQuota.get(name)
    return r && r.day === utcDay() ? r.count : 0
  }
  const grantedToday = (name: string): number => {
    const r = roleQuota.get(name)
    return r && r.day === utcDay() ? (r.granted ?? 0) : 0
  }
  // A role's live daily budget — the tool calls remaining()/record() during a run, so the cap holds within a run, across
  // runs, and across restarts. limit null (no max_per_day) = unlimited, no enforcement.
  const makeQuota = (role: Role): RoleQuota => ({
    limit: role.maxPerDay,
    remaining: () => (role.maxPerDay == null ? Infinity : Math.max(0, role.maxPerDay + grantedToday(role.name) - countToday(role.name))),
    record: () => {
      const day = utcDay()
      const r = roleQuota.get(role.name)
      if (r && r.day === day) r.count++
      else roleQuota.set(role.name, { day, count: 1 })
      saveQuota()
    },
  })
  const summaries = new Map<string, string>() // last agent message per ticket — survives the log buffer, surfaces the human action
  const notesFetched = new Set<string>() // stuck tickets whose verdict comment we've pulled once for display
  const lastState = new Map<string, string>() // last-seen Linear state per ticket — drops a stale note on transition
  // Deadlock detection. `progress` is a forward-progress clock per ticket: it resets whenever the ticket reaches a
  // pipeline state it hasn't been in this lifecycle; while it sits in already-seen states it burns down. A ticket
  // that spends tokens/time without resetting is looping → auto-block it. `deadlocked` remembers a first offense so
  // a second one escalates past the blocked phase straight to a human.
  const progress = new Map<string, { since: number; tokensAtProgress: number; seen: Set<string> }>()
  const deadlocked = new Set<string>()

  // One rolling transcript per ticket (LRU). NOT cleared on re-dispatch, so operator chat + prior phases survive a
  // continuation/handoff; `restart` clears it for a from-scratch run. `touchLog` marks a ticket most-recent and
  // evicts the oldest past the cap.
  const getLog = (identifier: string): string[] => logs.get(identifier) ?? []
  const touchLog = (identifier: string): void => {
    const prev = logs.get(identifier) ?? []
    logs.delete(identifier)
    logs.set(identifier, prev)
    if (logs.size > LOG_TICKETS) {
      const oldest = logs.keys().next().value
      if (oldest && oldest !== identifier) logs.delete(oldest)
    }
  }

  // Worker placement. An issue is PINNED to one host for its whole life (continuation turns reuse the same VM so the
  // cloned workspace + workpad survive). hostCounts = pinned issues per host; the pin is held until the issue is
  // released (terminal / ineligible / hard-stop), NOT dropped between continuation turns.
  const placement = new Map<string, string>() // issue.id → host
  const hostCounts = new Map<string, number>()
  const hosts = (): string[] => cfg.worker.sshHosts
  const freePlacement = (id: string): void => {
    const h = placement.get(id)
    if (h) hostCounts.set(h, Math.max((hostCounts.get(h) ?? 1) - 1, 0))
    placement.delete(id)
  }
  // Where to run an issue: null = local (no hosts configured); its existing pin if any; else the first host with a
  // free slot; else undefined = every worker is full, wait for one.
  const placeFor = (id: string): string | null | undefined => {
    if (hosts().length === 0) return null
    const pinned = placement.get(id)
    if (pinned && hosts().includes(pinned)) return pinned
    // Resume lands where the rollout lives: prefer the worker holding this ticket's thread (e.g. after a restart
    // dropped the in-memory pin), if it has a free slot; else fall back to spreading.
    const held = threadRecs.get(id)?.host
    if (held && hosts().includes(held) && (hostCounts.get(held) ?? 0) < cfg.worker.maxPerHost) return held
    // Spread, don't pack: of the hosts with a free slot, take the least-loaded so VMs fill evenly.
    const free = hosts().filter((h) => (hostCounts.get(h) ?? 0) < cfg.worker.maxPerHost)
    if (free.length === 0) return undefined
    return free.reduce((a, b) => ((hostCounts.get(a) ?? 0) <= (hostCounts.get(b) ?? 0) ? a : b))
  }
  const displayCap = (): number => (hosts().length === 0 ? cfg.agent.maxConcurrentAgents : Math.min(cfg.agent.maxConcurrentAgents, hosts().length * cfg.worker.maxPerHost))

  const slots = (): number => Math.max(cfg.agent.maxConcurrentAgents - running.size, 0)
  const norm = (s: string): string => s.trim().toLowerCase()
  const isTerminal = (s: string): boolean => cfg.tracker.terminalStates.some((t) => norm(t) === norm(s))
  const isActive = (s: string): boolean => cfg.tracker.activeStates.some((t) => norm(t) === norm(s))
  const isRoutable = (i: Issue): boolean => cfg.tracker.requiredLabels.every((l) => i.labels.some((x) => norm(x) === l))
  const planBlocked = (i: Issue): boolean => phaseOf(cfg, i.state) === 'plan' && i.blockers.some((b) => b.state == null || !isTerminal(b.state))
  const eligible = (i: Issue): boolean =>
    isActive(i.state) && !isTerminal(i.state) && isRoutable(i) && !planBlocked(i) && !claimed.has(i.id) && !running.has(i.id)
  // Per-state concurrency (Symphony §8.2/§8.3): an issue in state S is dispatch-eligible only if fewer than
  // max_concurrent_agents_by_state[S] agents are already running on issues in S (counted by their CURRENT state). No
  // entry for S = no per-state limit (the global cap is the only ceiling). Bounds an expensive stage's blast radius —
  // one phase (e.g. the blocked phase on `QA blocked`) can't consume every slot.
  const stateFull = (state: string): boolean => {
    const cap = cfg.agent.maxConcurrentByState[norm(state)]
    if (cap === undefined) return false
    let n = 0
    for (const e of running.values()) if (norm(e.issue.state) === norm(state)) n++
    return n >= cap
  }

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
    freePlacement(id)
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
    const host = placement.get(id) ?? null
    stopRun(id)
    freePlacement(id)
    if (cleanup && e) removeWorkspace(cfg, e.issue.identifier, host)
  }

  // Toggle the panic switch. On pause, halt every running pipeline agent + pool role so the gateway/Linear stop being
  // hit immediately; dispatch stays off (guarded in the loop/retry/role paths) until resumed. The poll keeps running.
  const setPaused = (v: boolean): void => {
    paused = v
    savePaused(v)
    if (v) {
      for (const id of [...running.keys()]) stopRun(id)
      for (const [, e] of roleRunning) e.handle.stop()
      log('■ factory PAUSED by operator — dispatch off, all running agents halted')
    } else {
      log('▶ factory RESUMED by operator')
    }
  }

  const retryDelay = (attempt: number, continuation: boolean): number =>
    continuation && attempt === 1 ? CONTINUATION_MS : Math.min(FAILURE_BASE_MS * 2 ** Math.min(attempt - 1, 10), cfg.agent.maxRetryBackoffMs)

  const scheduleRetry = (id: string, identifier: string, attempt: number, continuation: boolean): void => {
    clearRetry(id)
    const delay = retryDelay(attempt, continuation)
    const token = ++tokenSeq
    const timer = setTimeout(() => void onRetry(id, identifier, attempt, token), delay)
    retries.set(id, { timer, token, identifier, attempt, dueAt: Date.now() + delay })
  }

  const dispatch = (issue: Issue, attempt: number, host: string | null): void => {
    clearRetry(issue.id)
    claimed.add(issue.id)
    if (host && !placement.has(issue.id)) {
      placement.set(issue.id, host)
      hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1)
    }
    touchLog(issue.identifier)
    const entry: RunningEntry = { issue, handle: undefined as unknown as AgentHandle, retryAttempt: attempt > 0 ? attempt : 0, startedAt: Date.now(), lastActivity: Date.now(), turn: 0, activity: 'starting…', host, phase: phaseOf(cfg, issue.state), tokenBase: zeroCounts(), turnId: null }
    running.set(issue.id, entry)
    // §13.1: session_id = `${threadId}-${turnId}` when both known; threadId alone until first turn id arrives
    const sessionId = (): string => { const t = threadRecs.get(issue.id)?.threadId; return t ? `${t}${entry.turnId ? `-${entry.turnId}` : ''}` : '' }
    log(`→ ${issue.identifier} (${issue.state})${attempt > 0 ? ` retry#${attempt}` : ''}${host ? ` @ ${host}` : ''}`)
    stats.record({ identifier: issue.identifier, kind: 'dispatch', threadId: threadRecs.get(issue.id)?.threadId, host, totalTokens: grandTotal(tokens, issue.identifier), account: acct(host) })
    entry.handle = startAgent(cfg, issue, attempt > 0 ? attempt : null, host, (e) => {
      entry.lastActivity = Date.now()
      if (e.turn != null) entry.turn = e.turn
      if (e.label != null) entry.activity = e.label
      if (e.turnId) entry.turnId = e.turnId // §13.1: track latest turn id for session_id composition
      if (e.threadId) {
        threadRecs.set(issue.id, { threadId: e.threadId, host })
        saveThreads()
      }
      if (e.log != null) {
        const arr = logs.get(issue.identifier)
        if (arr) {
          arr.push(e.log)
          if (arr.length > 600) arr.splice(0, arr.length - 600)
          saveLogs()
        }
        if (e.log.startsWith('● ')) summaries.set(issue.identifier, e.log.slice(2, 400)) // keep the latest agent message
      }
      if (e.tokens) {
        // codex sends the thread-cumulative total each turn; fold the delta into this ticket's phase tally.
        const acc = ((tokens[issue.identifier] ??= {})[entry.phase] ??= zeroCounts())
        foldDelta(acc, e.tokens, entry.tokenBase)
        entry.tokenBase = e.tokens
        saveTokens()
      }
      if (e.rateLimits) lastRateLimits = e.rateLimits // newest coding-agent rate-limit snapshot for the dashboard
    }, threadRecs.get(issue.id)?.threadId ?? null, (id) => lastBoard.find((i) => i.id === id || i.identifier === id) ?? null, () => { const q = pendingChat.get(issue.id) ?? []; pendingChat.delete(issue.id); return q })
    void entry.handle.done.then(async (outcome) => {
      if (running.get(issue.id) !== entry) return // already terminated by reconcile
      running.delete(issue.id)
      endedRuntimeMs += Date.now() - entry.startedAt // fold this session's wall-clock into the aggregate runtime (§13.3)
      const sid = sessionId()
      if (outcome.ok) {
        scheduleRetry(issue.id, issue.identifier, 1, true) // re-check & continue while active
        log(`✓ ${issue.identifier} session done${sid ? ` session=${sid}` : ''}`) // §13.1
        stats.record({ identifier: issue.identifier, kind: 'session_done', threadId: threadRecs.get(issue.id)?.threadId, host: entry.host, totalTokens: grandTotal(tokens, issue.identifier), account: acct(entry.host) })
      } else {
        const code = outcome.code
        // §10.6: a genuinely-missing codex binary is non-transient — retrying forever won't fix it; route to Needs
        // human so an operator can diagnose. Ambiguous codes (invalid_workspace_cwd etc.) may be transient
        // version-skew, so they keep retrying via the normal backoff rather than parking.
        const isSetupFailure = code === 'codex_not_found'
        warn(`✗ ${issue.identifier}: ${(outcome.error ?? '').slice(0, 200)}${sid ? ` session=${sid}` : ''}${code ? ` code=${code}` : ''}`) // §13.1
        if (isSetupFailure) {
          log(`setup failure ${issue.identifier} (${code}) → Needs Engineer`)
          try {
            await moveIssue(cfg, issue.id, 'Needs Engineer')
            await postComment(cfg, issue.id, `## ⚠️ Setup failure — needs operator\nThe factory cannot run this ticket: \`${code}\`.\n\n> ${(outcome.error ?? '').slice(0, 400)}\n\nManual intervention required before it can retry.`)
          } catch (e) {
            warn(`setup failure move ${issue.identifier}: ${e instanceof Error ? e.message : String(e)}`)
          }
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
    if (paused) {
      claimed.delete(id) // panic switch: drop the claim (keep the pin, like stopRun) so the main loop re-dispatches on resume
      return
    }
    let candidates: Issue[]
    try {
      candidates = await fetchCandidates(cfg)
    } catch {
      scheduleRetry(id, identifier, attempt + 1, false)
      return
    }
    const issue = candidates.find((i) => i.id === id)
    if (!issue) return release(id)
    if (isTerminal(issue.state)) {
      removeWorkspace(cfg, issue.identifier, placement.get(id) ?? null)
      return release(id)
    }
    if (!eligible(issue)) return release(id)
    if (slots() <= 0 || stateFull(issue.state)) return scheduleRetry(id, identifier, attempt + 1, false)
    const host = placeFor(id) // a continuation reuses its pinned VM; a fresh retry takes any free worker
    if (host === undefined) return scheduleRetry(id, identifier, attempt + 1, false)
    dispatch(issue, attempt, host)
  }

  async function reconcile(): Promise<void> {
    if (cfg.codex.stallTimeoutMs > 0) {
      const now = Date.now()
      for (const [id, e] of [...running]) {
        if (now - e.lastActivity > cfg.codex.stallTimeoutMs) {
          const next = e.retryAttempt > 0 ? e.retryAttempt + 1 : 1
          terminate(id, false)
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
      if (isTerminal(i.state)) terminate(i.id, true)
      else if (!isRoutable(i)) terminate(i.id, false)
      else if (isActive(i.state)) running.get(i.id)!.issue = i
      else terminate(i.id, false)
    }
    for (const id of ids) if (!seen.has(id) && running.has(id)) terminate(id, false)
  }

  const workerDesc = hosts().length === 0 ? 'local' : `${hosts().length} VM${hosts().length > 1 ? 's' : ''}×${cfg.worker.maxPerHost}`
  log(`bunion up · scope=${cfg.tracker.team ?? cfg.tracker.projectSlug}${cfg.tracker.requiredLabels.length ? ` [${cfg.tracker.requiredLabels.join(',')}]` : ''} · cap=${displayCap()} · workers=${workerDesc} · poll=${cfg.pollIntervalMs}ms`)

  // §8.6 startup workspace hygiene: an immediate pruneWorkspaces() sweep runs below (after its setInterval) — it's
  // bounded by the workspace dirs that ACTUALLY exist and is fire-and-forget (spawn, not a sync per-terminal-ticket
  // scan), so stale dirs clear at startup without blocking the event loop.

  const rankStatus = (s: BoardItem['status']): number => (s === 'running' ? 0 : s === 'retrying' ? 1 : s === 'queued' ? 2 : 3)
  const snapshot = (): Snapshot => {
    const board = new Map<string, BoardItem>()
    const base = (i: Issue): BoardItem => ({
      identifier: i.identifier, title: i.title, state: i.state, priority: i.priority, host: placement.get(i.id) ?? null, prUrl: i.prUrl,
      url: i.url, note: summaries.get(i.identifier) ?? null,
      status: isActive(i.state) ? 'queued' : 'handoff',
      enteredAt: i.startedAt ? Date.parse(i.startedAt) : null, endedAt: i.completedAt ? Date.parse(i.completedAt) : null,
      turn: 0, activity: '', startedAt: 0, lastActivity: 0, retryAttempt: 0, retryDueAt: null,
      tokens: phaseBreakdown(tokens, i.identifier),
    })
    for (const c of lastBoard) board.set(c.id, base(c))
    for (const [id, r] of retries) {
      const it = board.get(id)
      if (it) {
        it.status = 'retrying'
        it.retryAttempt = r.attempt
        it.retryDueAt = r.dueAt
      }
    }
    for (const [id, e] of running) {
      const it = board.get(id) ?? base(e.issue)
      board.set(id, it)
      it.status = 'running'
      it.state = e.issue.state
      it.title = e.issue.title
      it.turn = e.turn
      it.activity = e.activity
      it.startedAt = e.startedAt
      it.lastActivity = e.lastActivity
      it.retryAttempt = e.retryAttempt
      it.host = e.host
    }
    const items = [...board.values()].sort((a, b) => rankStatus(a.status) - rankStatus(b.status) || rank(a.priority) - rank(b.priority) || a.identifier.localeCompare(b.identifier))
    const acct: Record<string, number> = {}
    for (const h of hosts()) { const gw = gatewayHost.get(h); if (gw === undefined) continue; const label = gw ? (cfg.worker.gatewayAccounts[gw] ?? gw) : 'unknown'; acct[label] = (acct[label] ?? 0) + 1 }
    const gatewayAccounts = Object.entries(acct).map(([l, n]) => `${l} ×${n}`)
    const t = totals(tokens)
    return {
      scope: `${cfg.tracker.team ?? cfg.tracker.projectSlug}${cfg.tracker.requiredLabels.length ? ` [${cfg.tracker.requiredLabels.join(',')}]` : ''}`,
      cap: displayCap(),
      gatewayAccounts,
      items,
      totalTokens: t.total,
      totalInput: t.input,
      totalOutput: t.output,
      totalCached: t.cached,
      paused,
      rateLimits: lastRateLimits,
      secondsRunning: Math.round((endedRuntimeMs + [...running.values()].reduce((s, e) => s + (Date.now() - e.startedAt), 0)) / 1000),
      roles: cfg.roles.map(roleItem),
      columns: cfg.boardColumns.map((c) => ({ name: c.name, c: c.color, states: c.states, inert: !c.states.some((s) => isActive(s)) })),
    }
  }
  // One chat turn against a persisted thread (a ticket OR a pool role): resume it on its worker, run the operator's
  // message, and append both sides to the `logKey` transcript. The agent answers from the thread's context. `tools`
  // decides how first-class the turn is: ticket chat gets the Linear tools so it can ACT on steering (move the ticket's
  // status + update the workpad) and narrate it; role chat gets none (advisory — it acts on its next scheduled run).
  // The file sandbox stays read-only either way, so chat never edits code/pushes — the code work happens at the next
  // dispatch (which resumes THIS thread). cwd is the worker HOME, not the ticket workspace (handed-off workspaces get
  // pruned; codex thread/resume loads context regardless of cwd).
  const chatTurn = async (logKey: string, threadId: string, host: string | null, displayMsg: string, prompt: string, label: string, tools: ConstructorParameters<typeof AppServerSession>[1]): Promise<{ ok: boolean; reply?: string; msg?: string }> => {
    const cwd = host ? remoteHome(host) : homedir()
    if (host && !cwd) return { ok: false, msg: 'cannot resolve the worker home' }
    let lg = logs.get(logKey)
    if (!lg) {
      lg = []
      logs.set(logKey, lg)
    }
    touchLog(logKey) // bump to MRU so the LRU cap doesn't evict this transcript mid-conversation on a busy board
    lg.push(`○ ${displayMsg}`) // operator turn — shows in the transcript immediately
    saveLogs()
    const replies: string[] = []
    const chat = new AppServerSession(cfg, tools, (e) => {
      if (e.log && e.log.startsWith('● ')) replies.push(e.log.slice(2))
    })
    try {
      await chat.start(cwd, host)
      await chat.resumeThread(threadId)
      await chat.runTurn(threadId, cwd, prompt, label, { type: 'readOnly' })
    } catch (e) {
      chat.stop()
      const m = e instanceof Error ? e.message : String(e)
      lg.push(`● (couldn't reach the agent: ${m})`)
      saveLogs()
      return { ok: false, msg: m }
    }
    chat.stop()
    const reply = replies.join('\n\n').trim() || '(no reply)'
    lg.push(`● ${reply}`)
    if (lg.length > 600) lg.splice(0, lg.length - 600)
    saveLogs()
    log(`chat: ${logKey} ←→ operator`)
    return { ok: true, reply }
  }
  // Operator chat. A pool-role name steers that role (it acts on its next scheduled run); otherwise it's a ticket —
  // idle tickets only, since a running agent owns the thread.
  const onChat = async (identifier: string, text: string): Promise<{ ok: boolean; reply?: string; msg?: string }> => {
    const msg = text.trim()
    if (!msg) return { ok: false, msg: 'empty message' }
    const role = cfg.roles.find((r) => r.name === identifier)
    if (role) {
      if (roleRunning.has(role.name)) return { ok: false, msg: 'the role is mid-run — message it once it is idle' }
      const rec = threadRecs.get(`role:${role.name}`)
      if (!rec?.threadId) return { ok: false, msg: 'no thread yet — this role has not run' }
      return chatTurn(role.name, rec.threadId, rec.host, msg, rolePrompt(role, msg), `${role.name}: operator chat`, []) // role chat stays advisory — no tools
    }
    const issue = lastBoard.find((i) => i.identifier === identifier)
    if (!issue) return { ok: false, msg: 'ticket not on the board' }
    if (running.has(issue.id)) {
      // The agent owns the codex thread mid-turn — a concurrent chat turn would collide. Queue the message and inject
      // it into the agent's next continuation turn; echo it to the transcript so the operator sees it landed.
      const q = pendingChat.get(issue.id) ?? []
      q.push(msg)
      pendingChat.set(issue.id, q)
      const lg = logs.get(identifier) ?? (logs.set(identifier, []).get(identifier)!)
      lg.push(`○ ${msg}  ⟨queued — the agent reads this on its next turn⟩`)
      saveLogs()
      return { ok: true, msg: 'queued — the agent will pick it up on its next turn' }
    }
    const rec = threadRecs.get(issue.id)
    if (!rec?.threadId) return { ok: false, msg: 'no thread yet — this ticket has not run' }
    // First-class ticket chat: give it the Linear tools so it can move state + update the workpad on the operator's steering.
    return chatTurn(identifier, rec.threadId, placement.get(issue.id) ?? rec.host, msg, chatPrompt(msg), `${identifier}: operator chat`, [linearGraphqlTool(cfg, phaseOf(cfg, issue.state)), linearReadTool((id) => lastBoard.find((i) => i.id === id || i.identifier === id) ?? null)])
  }

  // Operator actions = pure pipeline transitions. The thread carries context (chat + prior phases), so an action just
  // advances the ticket and the next dispatch resumes the same thread on the same worker. `restart` is the hard reset:
  // wipe the workspace AND drop the thread so the ticket replans from scratch.
  const onAction = async (identifier: string, action: string): Promise<{ ok: boolean; msg?: string }> => {
    if (identifier === '__pause__') {
      setPaused(!paused)
      return { ok: true, msg: paused ? 'factory paused' : 'factory resumed' }
    }
    if (action === 'pause') {
      // Per-role pause: stop THIS pool role's cadence runs independently of the global factory pause; persisted.
      if (!cfg.roles.some((r) => r.name === identifier)) return { ok: false, msg: `unknown role: ${identifier}` }
      if (rolePaused.has(identifier)) rolePaused.delete(identifier)
      else rolePaused.add(identifier)
      saveRolePaused()
      const now = rolePaused.has(identifier)
      log(`action: ${identifier} ${now ? 'paused' : 'resumed'} (operator)`)
      return { ok: true, msg: `${identifier} ${now ? 'paused' : 'resumed'}` }
    }
    if (action === 'grant') {
      // Operator top-up: extend a capped pool role by another day's allowance for today only (resets at UTC midnight).
      const role = cfg.roles.find((r) => r.name === identifier)
      if (!role) return { ok: false, msg: `unknown role: ${identifier}` }
      if (role.maxPerDay == null) return { ok: false, msg: `${identifier} is uncapped — nothing to grant` }
      const day = utcDay()
      const r = roleQuota.get(identifier)
      if (r && r.day === day) r.granted = (r.granted ?? 0) + role.maxPerDay
      else roleQuota.set(identifier, { day, count: 0, granted: role.maxPerDay })
      saveQuota()
      log(`action: granted ${identifier} +${role.maxPerDay} tickets for today (operator)`)
      return { ok: true, msg: `${identifier} +${role.maxPerDay} granted for today` }
    }
    if (action === 'run') {
      // Operator manual run: dispatch a pool role NOW, skipping its cadence wait + the daily-cap gate (the
      // linear_graphql tool still enforces filing limits, so a capped role runs + reports but files nothing).
      const i = cfg.roles.findIndex((r) => r.name === identifier)
      if (i < 0) return { ok: false, msg: `unknown role: ${identifier}` }
      if (paused) return { ok: false, msg: 'factory is paused — resume first' }
      if (rolePaused.has(identifier)) return { ok: false, msg: `${identifier} is paused — resume it first` }
      if (roleRunning.has(identifier)) return { ok: false, msg: `${identifier} is already running` }
      dispatchRole(cfg.roles[i]!, i, true)
      return { ok: true, msg: `${identifier} run started` }
    }
    const issue = lastBoard.find((i) => i.identifier === identifier)
    if (!issue) return { ok: false, msg: 'ticket not on the board' }
    const host = placement.get(issue.id) ?? null
    try {
      if (action === 'bump') {
        // Operator budget bump: grant another hard-cap's worth of headroom to THIS ticket (kept cumulative — its spend
        // is not erased), so a ticket parked by the token cap can finish. effectiveCap folds the grant into the sweep.
        const inc = cfg.deadlock.hardTokenCap
        ticketGrants.set(identifier, (ticketGrants.get(identifier) ?? 0) + inc)
        saveGrants()
        const cap = effectiveCap(identifier)
        log(`action: ${identifier} budget +${Math.round(inc / 1e6)}M → ${Math.round(cap / 1e6)}M cap (operator)`)
        const s = norm(issue.state)
        if (s === 'needs engineer' || s === 'qa blocked') {
          // It was parked (likely by the cap) — re-open to In Progress with a fresh no-progress clock so it can use the
          // new headroom; the thread resumes on the next dispatch.
          stopRun(issue.id)
          progress.delete(issue.id)
          notesFetched.delete(issue.id)
          summaries.delete(issue.identifier)
          await moveIssue(cfg, issue.id, 'In Progress')
          scheduleRetry(issue.id, issue.identifier, 1, true)
          return { ok: true, msg: `+${Math.round(inc / 1e6)}M budget → re-opened to In Progress` }
        }
        return { ok: true, msg: `+${Math.round(inc / 1e6)}M budget (cap now ${Math.round(cap / 1e6)}M)` }
      }
      if (action === 'restart') {
        terminate(issue.id, false)
        removeWorkspace(cfg, issue.identifier, host)
        release(issue.id)
        threadRecs.delete(issue.id)
        saveThreads()
        logs.set(issue.identifier, []) // from-scratch run: clear the transcript too
        saveLogs()
        log(`action: ${identifier} restart (operator, fresh thread)`)
        return { ok: true, msg: 'restarting fresh' }
      }
      if (action === 'to-qa' || action === 'to-build') {
        const target = action === 'to-qa' ? 'QA Requested' : 'In Progress'
        stopRun(issue.id) // stop the current turn but keep the pin + workspace + thread → the move resumes it
        await moveIssue(cfg, issue.id, target)
        notesFetched.delete(issue.id)
        summaries.delete(issue.identifier)
        scheduleRetry(issue.id, issue.identifier, 1, true) // continuation: re-dispatch on the pinned worker, resuming
        log(`action: ${identifier} → ${target} (operator)`)
        return { ok: true, msg: `moved to ${target}` }
      }
      if (action.startsWith('move:')) {
        const target = action.slice('move:'.length)
        stopRun(issue.id) // stop any current turn; keep pin + workspace + thread
        await moveIssue(cfg, issue.id, target)
        notesFetched.delete(issue.id)
        summaries.delete(issue.identifier)
        scheduleRetry(issue.id, issue.identifier, 1, true) // re-dispatch (resume) if the target is active; the poll idles/cleans up otherwise
        log(`action: ${identifier} → ${target} (operator move)`)
        return { ok: true, msg: `moved to ${target}` }
      }
      return { ok: false, msg: `unknown action: ${action}` }
    } catch (e) {
      return { ok: false, msg: e instanceof Error ? e.message : String(e) }
    }
  }
  // The pool. Each configured role runs on its own cadence with a persistent thread (resumed each run so it remembers
  // what it filed) and its own model, filing tickets through the Linear tool. A role pins to a worker (round-robin, or
  // the one holding its thread) and does NOT count against the per-ticket cap — roles are few and infrequent.
  const roleHostFor = (role: Role, i: number): string | null => {
    const held = threadRecs.get(`role:${role.name}`)?.host
    if (held && hosts().includes(held)) return held
    const hs = hosts()
    return hs.length ? (hs[i % hs.length] ?? null) : null
  }
  // The brain's live operational state, rendered into a pool role's prompt — a worker VM can't see any of this (the
  // daemon log, token burns, what's stuck), so the mechanic especially gets it first-class instead of guessing.
  const brainDigest = (): string => {
    const lc = (s: string): string => s.trim().toLowerCase()
    const needs = lastBoard.filter((i) => lc(i.state) === 'needs engineer').map((i) => i.identifier)
    const blocked = lastBoard.filter((i) => lc(i.state) === 'qa blocked').map((i) => i.identifier)
    const tok = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${Math.round(n / 1e6)}M` : `${Math.round(n / 1e3)}k`)
    const burns = Object.keys(tokens)
      .filter((id) => /^[A-Z][A-Z0-9]*-\d+$/.test(id))
      .map((id) => [id, grandTotal(tokens, id)] as const)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
    const warnings = recentLogs().filter((l) => /WARN|deadlock|timed out|not authenticated|unauthorized|✗|429|rate.?limit|auth/i.test(l)).slice(-12)
    return [
      `## Factory state — live from the brain (you run on a worker and cannot see any of this otherwise)`,
      `- Status: ${paused ? 'PAUSED' : 'running'}`,
      `- Stuck now: ${needs.length} Needs Engineer${needs.length ? ` (${needs.join(', ')})` : ''}; ${blocked.length} QA blocked${blocked.length ? ` (${blocked.join(', ')})` : ''}`,
      `- Top token burns: ${burns.length ? burns.map(([id, n]) => `${id} ${tok(n)}`).join(', ') : 'none tracked'}`,
      `- Recent brain warnings / errors / deadlocks (daemon.log tail):`,
      ...(warnings.length ? warnings.map((l) => `    ${l}`) : ['    (none recently — factory healthy)']),
      ``,
    ].join('\n')
  }
  const dispatchRole = (role: Role, i: number, force = false): void => {
    if (paused) return // operator panic switch — no role runs while paused
    if (rolePaused.has(role.name)) return // this pooler is individually paused by the operator
    if (roleRunning.has(role.name)) return // last cadence's run still going — skip this tick
    const quota = makeQuota(role)
    if (!force && quota.remaining() <= 0) {
      log(`◆ role ${role.name} skip — daily quota reached (${role.maxPerDay}/${role.maxPerDay}); resumes at UTC midnight`)
      return
    }
    const host = roleHostFor(role, i)
    if (!logs.has(role.name)) logs.set(role.name, [])
    const acc = ((tokens[role.name] ??= {}).pool ??= zeroCounts())
    const entry: RoleEntry = { handle: undefined as unknown as RoleHandle, activity: 'starting…', host, tokenBase: zeroCounts() }
    roleRunning.set(role.name, entry)
    log(`◆ role ${role.name} run${host ? ` @ ${host}` : ''}`)
    entry.handle = startRole(
      cfg,
      role,
      host,
      (e) => {
        if (e.label != null) entry.activity = e.label
        if (e.log != null) {
          const a = logs.get(role.name)
          if (a) {
            a.push(e.log)
            if (a.length > 600) a.splice(0, a.length - 600)
            saveLogs()
          }
        }
        if (e.threadId) {
          threadRecs.set(`role:${role.name}`, { threadId: e.threadId, host })
          saveThreads()
        }
        if (e.tokens) {
          foldDelta(acc, e.tokens, entry.tokenBase)
          entry.tokenBase = e.tokens
          saveTokens()
        }
      },
      threadRecs.get(`role:${role.name}`)?.threadId ?? null,
      quota,
      brainDigest(),
    )
    void entry.handle.done.then((o) => {
      roleRunning.delete(role.name)
      roleLast.set(role.name, Date.now())
      if (o.ok) log(`◆ role ${role.name} done`)
      else warn(`◆ role ${role.name}: ${(o.error ?? '').slice(0, 160)}`)
    })
  }
  const roleItem = (role: Role) => {
    const e = roleRunning.get(role.name)
    return {
      name: role.name,
      status: (e ? 'running' : 'idle') as 'running' | 'idle',
      activity: e ? e.activity : '',
      model: role.model,
      host: e?.host ?? threadRecs.get(`role:${role.name}`)?.host ?? null,
      tokens: tokens[role.name]?.pool?.total ?? 0,
      cadenceMs: role.cadenceMs,
      lastRunAt: roleLast.get(role.name) ?? null,
      filedToday: countToday(role.name),
      maxPerDay: role.maxPerDay,
      granted: grantedToday(role.name),
      paused: rolePaused.has(role.name),
    }
  }

  // Recover threads from worker rollouts for tickets bunion has no record of, then persist what was found. Runs
  // once on the first board; makes a pre-persistence handoff chattable.
  const runBackfill = async (board: Issue[]): Promise<void> => {
    const found = await backfillThreads(board, hosts(), (id) => threadRecs.has(id))
    let n = 0
    for (const [id, rec] of found)
      if (!threadRecs.has(id)) {
        threadRecs.set(id, rec)
        n++
      }
    if (n > 0) {
      saveThreads()
      log(`backfilled ${n} ticket thread(s) from worker rollouts`)
    }
  }
  if (cfg.dashboardPort) startDashboard(cfg.dashboardPort, snapshot, getLog, log, onAction, onChat, stats)

  // Start the pool — each role on its cadence, with a staggered first run shortly after startup. (Role config is read
  // at start; add/edit roles then restart.)
  cfg.roles.forEach((role, i) => {
    const tick = (): void => dispatchRole(role, i)
    setInterval(tick, role.cadenceMs)
    setTimeout(tick, 10_000 + i * 20_000)
  })

  // Periodic workspace hygiene: each ticket's checkout is ~5-6G (node_modules + git history), and stale ones pile
  // up as tickets cycle across VMs (every restart re-pins and orphans the old copy). Prune workspaces on each VM
  // that aren't currently pinned there AND haven't been touched in 20min. Fire-and-forget; never blocks the loop.
  const pruneWorkspaces = (): void => {
    const hosts = cfg.worker.sshHosts
    if (hosts.length === 0) return
    const keepByHost = new Map<string, string[]>()
    const keep = (h: string, id: string): void => {
      keepByHost.set(h, [...(keepByHost.get(h) ?? []), id])
    }
    for (const e of running.values()) if (e.host) keep(e.host, e.issue.identifier)
    for (const [id, r] of retries) {
      const h = placement.get(id)
      if (h) keep(h, r.identifier)
    }
    // After a restart `running`/`retries` are empty but in-flight tickets still own workspaces on unknown hosts — keep
    // every active-board ticket on ALL hosts so the sweep can't delete a dir a re-dispatch is about to reuse.
    for (const i of lastBoard) for (const h of hosts) keep(h, i.identifier)
    for (const host of hosts) {
      const list = `${(keepByHost.get(host) ?? []).join(' ')} SMOKE CLONETEST`
      const cmd = `for d in ~/.bunion/workspaces/*/; do [ -d "$d" ] || continue; id=$(basename "$d"); case " ${list} " in *" $id "*) continue;; esac; [ -z "$(find "$d" -maxdepth 0 -mmin -20 2>/dev/null)" ] && rm -rf "$d"; done`
      spawn('ssh', ['-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', host, cmd], { stdio: 'ignore' }).on('error', () => {})
    }
    log(`workspace prune swept ${hosts.length} VM(s)`)
  }
  if (cfg.worker.sshHosts.length) {
    setInterval(pruneWorkspaces, 20 * 60 * 1000)
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
      if (!paused && recentAuthFailures(60_000) >= 12) {
        setPaused(true)
        warn('Linear auth failing repeatedly (likely a dead/blocked token) — AUTO-PAUSED to stop hammering; fix the token, then resume')
      }
      await reconcile()
      let board: Issue[]
      try {
        // One labeled query is the whole board (active + handed-off). For an unlabeled config, fall back to the
        // active-states query. Either way, narrow host-side to the opt-in set.
        board = (cfg.tracker.requiredLabels.length ? await fetchBoard(cfg) : await fetchCandidates(cfg)).filter(isRoutable)
      } catch (e) {
        warn(`poll: ${e instanceof Error ? e.message : e}`)
        await sleep(cfg.pollIntervalMs)
        continue
      }
      lastBoard = board
      // Resolve one worker's LLM-gateway hostname per poll (cached for the daemon's life) → display-only account tracking.
      const unresolvedHost = hosts().find((h) => !gatewayHost.has(h))
      if (unresolvedHost) {
        const gw = sshExec(unresolvedHost, 'grep base_url "$HOME/.codex/config.toml"', 6000)
        const m = gw.ok ? /llm[0-9-]*\.int\.exe\.xyz/.exec(gw.out) : null
        gatewayHost.set(unresolvedHost, m ? m[0] : '')
      }
      if (!backfilled) {
        backfilled = true
        void runBackfill(board)
        pruneWorkspaces() // §8.6: first sweep now that the board is known, so in-flight workspaces are protected
      }
      // Surface WHY a ticket is stuck: pull its workpad Verdict for the blocked + needs-human states (not while an
      // agent is live on it — its own messages fill the note then). Clear a cached note when a ticket changes state
      // so a qa-blocked verdict doesn't linger after the blocked phase escalates it to Needs Engineer.
      const now = Date.now()
      const stuck: { issue: Issue; target: string; reason: string }[] = []
      for (const i of board) {
        if (lastState.get(i.id) !== i.state) {
          const prev = lastState.get(i.id)
          lastState.set(i.id, i.state)
          summaries.delete(i.identifier)
          notesFetched.delete(i.id)
          // Record the state transition (skip first-sight / restart re-observations — only real changes from a known prior state).
          if (prev !== undefined) stats.record({ identifier: i.identifier, kind: 'transition', fromState: prev, toState: i.state, threadId: threadRecs.get(i.id)?.threadId, totalTokens: grandTotal(tokens, i.identifier), account: acct(placement.get(i.id) ?? null), host: placement.get(i.id) ?? null })
        }
        // Forward-progress clock: reaching a not-yet-seen state resets it; sitting in seen states burns it down.
        const pr = progress.get(i.id) ?? { since: now, tokensAtProgress: grandTotal(tokens, i.identifier), seen: new Set<string>() }
        if (!pr.seen.has(norm(i.state))) {
          pr.seen.add(norm(i.state))
          pr.since = now
          pr.tokensAtProgress = grandTotal(tokens, i.identifier)
        }
        progress.set(i.id, pr)
        if (isActive(i.state) && !isTerminal(i.state)) {
          const total = grandTotal(tokens, i.identifier)
          const cap = effectiveCap(i.identifier)
          if (total >= cap) {
            // Absolute blast-radius cap (plus any operator budget bump): even a ticket that keeps reaching new states
            // (which resets the no-progress clock) must never burn unbounded. Straight to Needs Engineer.
            stuck.push({ issue: i, target: 'Needs Engineer', reason: `burned ${Math.round(total / 1e6)}M tokens — hit the ${Math.round(cap / 1e6)}M per-ticket cap` })
          } else {
            // No-progress deadlock: a ticket deadlocking while IN `QA blocked` means the triage itself is looping →
            // straight to Needs Engineer. Anywhere else: 1st offense → QA blocked (let it triage), 2nd → Needs Engineer.
            const reason = deadlockReason(total - pr.tokensAtProgress, now - pr.since, cfg.deadlock)
            if (reason) stuck.push({ issue: i, target: norm(i.state) === 'qa blocked' || deadlocked.has(i.id) ? 'Needs Engineer' : 'QA blocked', reason })
          }
        }
        const s = norm(i.state)
        if ((s === 'qa blocked' || s === 'needs engineer' || s === 'stg - ready to merge') && !running.has(i.id) && !summaries.has(i.identifier) && !notesFetched.has(i.id)) {
          notesFetched.add(i.id)
          void fetchLatestNote(cfg, i.id).then((n) => n && summaries.set(i.identifier, n)).catch(() => {})
        }
      }
      for (const id of [...progress.keys()]) if (!board.some((i) => i.id === id)) { progress.delete(id); deadlocked.delete(id) }
      // Deadlock sweep: no forward progress + resource burn → move to the blocked state (the blocked phase triages it),
      // or to Needs Engineer if it already deadlocked once. Await the move so it isn't re-dispatched below this poll.
      for (const { issue, target, reason } of stuck) {
        deadlocked.add(issue.id)
        terminate(issue.id, false)
        progress.delete(issue.id)
        lastState.set(issue.id, target)
        issue.state = target
        log(`deadlock: ${issue.identifier} ${reason} → ${target}`)
        stats.record({ identifier: issue.identifier, kind: reason.includes('per-ticket cap') ? 'cap' : 'deadlock', toState: target, threadId: threadRecs.get(issue.id)?.threadId, totalTokens: grandTotal(tokens, issue.identifier), account: acct(placement.get(issue.id) ?? null), detail: reason })
        try {
          await moveIssue(cfg, issue.id, target)
          await postComment(cfg, issue.id, `## 🔁 Auto-blocked — deadlock\nThe factory ${reason} on this ticket, so I moved it to \`${target}\` instead of looping further.${target === 'QA blocked' ? '\n\n**Blocked phase:** if there is no concrete, fixable meta-problem here, escalate to `Needs Engineer` — do not just send it back to loop again.' : ''}`)
        } catch (e) {
          warn(`deadlock move ${issue.identifier}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (!paused && slots() > 0) {
        for (const issue of board.filter((i) => isActive(i.state)).sort(byDispatch)) {
          if (slots() <= 0) break
          if (!eligible(issue)) continue
          if (stateFull(issue.state)) continue // per-state concurrency cap reached — skip; this issue retries next poll
          const host = placeFor(issue.id)
          if (host === undefined) continue // every worker VM is full — try this issue again next poll
          dispatch(issue, 0, host)
        }
      }
    } catch (e) {
      warn(`tick: ${e instanceof Error ? e.message : e}`)
    }
    await sleep(cfg.pollIntervalMs)
  }
}

// A ticket is deadlocked when it keeps spending tokens/time without advancing to a pipeline state it hasn't
// reached this lifecycle (e.g. oscillating In Progress ↔ QA Requested, or a fix that never lands). Returns a
// human-readable reason or null. Pure so it's unit-testable.
export function deadlockReason(tokensSinceProgress: number, msSinceProgress: number, dl: Omit<Config['deadlock'], 'hardTokenCap'>): string | null {
  const mins = Math.round(msSinceProgress / 60_000)
  if (msSinceProgress >= dl.hardStallMs) return `stuck ${mins}min with no forward progress`
  if (tokensSinceProgress >= dl.tokens && msSinceProgress >= dl.stallMs)
    return `burned ${(tokensSinceProgress / 1e6).toFixed(0)}M tokens over ${mins}min with no forward progress`
  return null
}

// An operator chat turn: read-only, answer from the thread's own context. Terse so it doesn't crowd the history.
function chatPrompt(msg: string): string {
  return `The operator is messaging you directly about this ticket, with this thread's full context. You can ACT on their steering through Linear via \`linear_graphql\`: update the \`## Codex Workpad\` and move the ticket's status. Narrate what you do plainly (e.g. "ok — recording the simpler plan in the workpad and moving this to In Progress so the build picks it up"). When their steering means the code should change, capture the concrete change in the workpad and move the ticket to \`In Progress\` — do this even if it is parked in STG - Ready to merge / QA blocked, because that re-enters it into the pipeline and the build agent resumes THIS thread to make the edits. Do NOT edit files, run commands, or push in this turn — only Linear. If the operator is just asking a question, answer it and change nothing. Operator:\n\n${msg}`
}

// An operator chat turn for a pool role — same read-only contract, framed as steering the role's standing focus.
function rolePrompt(role: Role, msg: string): string {
  return `The operator is messaging you, the "${role.name}" pool role — READ-ONLY: do not edit files, push, or change Linear; just answer using your thread's full context. If they are steering you (changing what you should focus on), acknowledge it; you will act on it on your next scheduled run. Operator:\n\n${msg}`
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
