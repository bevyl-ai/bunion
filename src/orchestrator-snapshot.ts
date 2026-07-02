import type { BoardItem, Snapshot } from './dashboard'
import type { Dispatcher } from './orchestrator-dispatch'
import type { Placement } from './orchestrator-placement'
import { isActive, openBlockers } from './orchestrator-predicates'
import type { RolePool } from './orchestrator-roles'
import type { PersistedState } from './orchestrator-state'
import { phaseBreakdown, totals } from './tokens'
import type { Config, Issue } from './types'

type PollHealth = { failureStreak: number; lastError: string | null; lastOkAt: number | null }

// running < retrying < blocked < queued < handoff: active work first, then things that'll dispatch soon, then
// things a human needs to unblock (waiting on it won't help), then things already handed off for review.
const rankStatus = (s: BoardItem['status']): number => (s === 'running' ? 0 : s === 'retrying' ? 1 : s === 'blocked' ? 2 : s === 'queued' ? 3 : 4)
const rank = (p: number): number => (p >= 1 && p <= 4 ? p : 5)

export function createSnapshot(getCfg: () => Config, state: PersistedState, placement: Placement, dispatcher: Dispatcher, roles: RolePool, summaries: Map<string, string>, getLastBoard: () => Issue[], gatewayHost: Map<string, string>, getPollHealth: () => PollHealth) {
  const snapshot = (): Snapshot => {
    const cfg = getCfg()
    const board = new Map<string, BoardItem>()
    const base = (i: Issue): BoardItem => {
      const blockers = openBlockers(i)
      return {
        identifier: i.identifier, title: i.title, state: i.state, priority: i.priority, host: placement.placement.get(i.id) ?? null, prUrl: i.prUrl,
        url: i.url, note: summaries.get(i.identifier) ?? null,
        status: blockers.length ? 'blocked' : isActive(cfg, i.state) ? 'queued' : 'handoff',
        blockedBy: blockers.length ? blockers.map((b) => ({ identifier: b.identifier ?? '?', state: b.state })) : null,
        enteredAt: i.startedAt ? Date.parse(i.startedAt) : null, endedAt: i.completedAt ? Date.parse(i.completedAt) : null,
        turn: 0, activity: '', startedAt: 0, lastActivity: 0, retryAttempt: 0, retryDueAt: null,
        tokens: phaseBreakdown(state.tokens, i.identifier),
      }
    }
    for (const c of getLastBoard()) board.set(c.id, base(c))
    for (const [id, r] of dispatcher.retries) {
      const it = board.get(id)
      if (it) {
        it.status = 'retrying'
        it.retryAttempt = r.attempt
        it.retryDueAt = r.dueAt
      }
    }
    for (const [id, e] of dispatcher.running) {
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
    const acctCounts: Record<string, number> = {}
    for (const h of placement.hosts()) { const gw = gatewayHost.get(h); if (gw === undefined) continue; const label = gw ? (cfg.worker.gatewayAccounts[gw] ?? gw) : 'unknown'; acctCounts[label] = (acctCounts[label] ?? 0) + 1 }
    const gatewayAccounts = Object.entries(acctCounts).map(([l, n]) => `${l} ×${n}`)
    const t = totals(state.tokens)
    return {
      scope: `${cfg.tracker.team ?? cfg.tracker.projectSlug}${cfg.tracker.requiredLabels.length ? ` [${cfg.tracker.requiredLabels.join(',')}]` : ''}`,
      cap: placement.displayCap(cfg.agent.maxConcurrentAgents),
      gatewayAccounts,
      items,
      totalTokens: t.total,
      totalInput: t.input,
      totalOutput: t.output,
      totalCached: t.cached,
      paused: state.paused,
      rateLimits: dispatcher.getLastRateLimits(),
      secondsRunning: Math.round((dispatcher.getEndedRuntimeMs() + [...dispatcher.running.values()].reduce((s, e) => s + (Date.now() - e.startedAt), 0)) / 1000),
      roles: cfg.roles.map(roles.roleItem),
      columns: cfg.boardColumns.map((c) => ({ name: c.name, c: c.color, states: c.states, inert: !c.states.some((s) => isActive(cfg, s)) })),
      terminalStates: cfg.tracker.terminalStates,
      pollHealth: getPollHealth(),
    }
  }
  return snapshot
}
