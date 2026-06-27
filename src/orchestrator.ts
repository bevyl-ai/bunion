import { startAgent, type AgentHandle } from './agent-runner'
import { loadConfig, validateConfig } from './config'
import { startDashboard, type Snapshot } from './dashboard'
import { fetchCandidates, fetchStatesByIds } from './linear'
import { log, warn } from './log'
import { removeWorkspace } from './workspace'
import type { Issue } from './types'

interface RunningEntry {
  issue: Issue
  handle: AgentHandle
  retryAttempt: number
  startedAt: number
  lastActivity: number
  turn: number
  activity: string
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

// The thin harness. Poll the tracker's active states, dispatch a Codex worker per issue (bounded), reconcile
// running issues against the tracker, and retry. It never touches Linear state or git — the AGENT does, via the
// workflow prompt + skills. Faithful to Symphony's orchestrator (SSH pool, blocked-state, dashboard omitted).
export async function start(workflowPath?: string): Promise<void> {
  let cfg = loadConfig(workflowPath)
  validateConfig(cfg)

  const running = new Map<string, RunningEntry>()
  const claimed = new Set<string>()
  const retries = new Map<string, RetryTimer>()
  const history: Snapshot['recent'] = []
  let tokenSeq = 0

  const pushHistory = (identifier: string, kind: string, detail: string | null): void => {
    history.unshift({ identifier, kind, at: Date.now(), detail })
    if (history.length > 40) history.length = 40
  }

  const slots = (): number => Math.max(cfg.agent.maxConcurrentAgents - running.size, 0)
  const norm = (s: string): string => s.trim().toLowerCase()
  const isTerminal = (s: string): boolean => cfg.tracker.terminalStates.some((t) => norm(t) === norm(s))
  const isActive = (s: string): boolean => cfg.tracker.activeStates.some((t) => norm(t) === norm(s))
  const isRoutable = (i: Issue): boolean => cfg.tracker.requiredLabels.every((l) => i.labels.some((x) => norm(x) === l))
  const todoBlocked = (i: Issue): boolean => norm(i.state) === 'todo' && i.blockers.some((b) => b.state == null || !isTerminal(b.state))
  const eligible = (i: Issue): boolean =>
    isActive(i.state) && !isTerminal(i.state) && isRoutable(i) && !todoBlocked(i) && !claimed.has(i.id) && !running.has(i.id)

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
  }
  const terminate = (id: string, cleanup: boolean): void => {
    const e = running.get(id)
    if (e) {
      e.handle.stop()
      running.delete(id)
    }
    claimed.delete(id)
    clearRetry(id)
    if (cleanup && e) removeWorkspace(cfg, e.issue.identifier)
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

  const dispatch = (issue: Issue, attempt: number): void => {
    clearRetry(issue.id)
    claimed.add(issue.id)
    const entry: RunningEntry = { issue, handle: undefined as unknown as AgentHandle, retryAttempt: attempt > 0 ? attempt : 0, startedAt: Date.now(), lastActivity: Date.now(), turn: 0, activity: 'starting…' }
    running.set(issue.id, entry)
    log(`→ ${issue.identifier} (${issue.state})${attempt > 0 ? ` retry#${attempt}` : ''}`)
    entry.handle = startAgent(cfg, issue, attempt > 0 ? attempt : null, (e) => {
      entry.lastActivity = Date.now()
      if (e.turn != null) entry.turn = e.turn
      if (e.label != null) entry.activity = e.label
    })
    void entry.handle.done.then((outcome) => {
      if (running.get(issue.id) !== entry) return // already terminated by reconcile
      running.delete(issue.id)
      if (outcome.ok) {
        pushHistory(issue.identifier, 'done', issue.state)
        scheduleRetry(issue.id, issue.identifier, 1, true) // re-check & continue while active
        log(`✓ ${issue.identifier} session done`)
      } else {
        pushHistory(issue.identifier, 'failed', (outcome.error ?? '').slice(0, 120))
        const next = entry.retryAttempt > 0 ? entry.retryAttempt + 1 : 1
        scheduleRetry(issue.id, issue.identifier, next, false)
        warn(`✗ ${issue.identifier}: ${(outcome.error ?? '').slice(0, 200)}`)
      }
    })
  }

  async function onRetry(id: string, identifier: string, attempt: number, token: number): Promise<void> {
    if (retries.get(id)?.token !== token) return // superseded
    retries.delete(id)
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
      removeWorkspace(cfg, issue.identifier)
      return release(id)
    }
    if (!eligible(issue)) return release(id)
    if (slots() <= 0) return scheduleRetry(id, identifier, attempt + 1, false)
    dispatch(issue, attempt)
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

  log(`bunion up · scope=${cfg.tracker.team ?? cfg.tracker.projectSlug}${cfg.tracker.requiredLabels.length ? ` [${cfg.tracker.requiredLabels.join(',')}]` : ''} · cap=${cfg.agent.maxConcurrentAgents} · poll=${cfg.pollIntervalMs}ms`)

  const snapshot = (): Snapshot => ({
    scope: `${cfg.tracker.team ?? cfg.tracker.projectSlug}${cfg.tracker.requiredLabels.length ? ` [${cfg.tracker.requiredLabels.join(',')}]` : ''}`,
    cap: cfg.agent.maxConcurrentAgents,
    pollMs: cfg.pollIntervalMs,
    now: Date.now(),
    running: [...running.values()].map((e) => ({ identifier: e.issue.identifier, title: e.issue.title, state: e.issue.state, startedAt: e.startedAt, lastActivity: e.lastActivity, retryAttempt: e.retryAttempt, turn: e.turn, activity: e.activity })),
    retrying: [...retries.values()].map((r) => ({ identifier: r.identifier, attempt: r.attempt, dueAt: r.dueAt })),
    recent: history.slice(0, 30),
  })
  if (cfg.dashboardPort) startDashboard(cfg.dashboardPort, snapshot, log)

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
      await reconcile()
      if (slots() > 0) {
        let candidates: Issue[]
        try {
          candidates = await fetchCandidates(cfg)
        } catch (e) {
          warn(`poll: ${e instanceof Error ? e.message : e}`)
          await sleep(cfg.pollIntervalMs)
          continue
        }
        for (const issue of candidates.sort(byDispatch)) {
          if (slots() <= 0) break
          if (eligible(issue)) dispatch(issue, 0)
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
