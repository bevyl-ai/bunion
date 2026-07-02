import { startRole, roleWorkspaceKey, type RoleHandle } from './role-runner'
import { log, recentLogs, warn } from './log'
import { foldDelta, grandTotal, resolveTokenBase, zeroCounts, type TokenTally } from './tokens'
import type { Placement } from './orchestrator-placement'
import { utcDay, type PersistedState } from './orchestrator-state'
import type { Config, Issue, Role, RoleQuota, TokenCounts } from './types'

interface RoleEntry {
  handle: RoleHandle
  activity: string
  host: string | null
  tokenBase: TokenCounts
}

export type RolePool = ReturnType<typeof createRolePool>

export type PollHealth = { failureStreak: number; lastError: string | null; lastOkAt: number | null }

const tok = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${Math.round(n / 1e6)}M` : `${Math.round(n / 1e3)}k`)
const lc = (s: string): string => s.trim().toLowerCase()

const age = (ms: number): string => {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 90) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 90) return `${min}m`
  const hr = Math.round(min / 60)
  return `${hr}h`
}

function staleBoardReason(pollHealth: PollHealth, pollIntervalMs: number, nowMs: number): string | null {
  if (pollHealth.lastOkAt == null) return 'no successful board poll yet'
  if (pollHealth.failureStreak > 0) {
    const err = pollHealth.lastError ? `: ${pollHealth.lastError}` : ''
    return `last poll failed${err}; last successful board poll ${age(nowMs - pollHealth.lastOkAt)} ago`
  }
  const staleAfterMs = pollIntervalMs * 2
  const sinceOk = nowMs - pollHealth.lastOkAt
  return sinceOk > staleAfterMs
    ? `last successful board poll ${age(sinceOk)} ago (freshness limit ${age(staleAfterMs)})`
    : null
}

export function renderBrainDigest(opts: {
  board: Issue[]
  paused: boolean
  tokens: TokenTally
  warnings: string[]
  pollHealth: PollHealth
  pollIntervalMs: number
  nowMs?: number
}): string {
  const nowMs = opts.nowMs ?? Date.now()
  const staleReason = staleBoardReason(opts.pollHealth, opts.pollIntervalMs, nowMs)
  const stuckLine = staleReason
    ? `- Stuck now: board state unknown/stale (${staleReason}); not showing precise Factory - Needs Engineer / QA - blocked counts`
    : (() => {
        const needs = opts.board.filter((i) => lc(i.state) === 'factory - needs engineer').map((i) => i.identifier)
        const blocked = opts.board.filter((i) => lc(i.state) === 'qa - blocked').map((i) => i.identifier)
        return `- Stuck now: ${needs.length} Factory - Needs Engineer${needs.length ? ` (${needs.join(', ')})` : ''}; ${blocked.length} QA - blocked${blocked.length ? ` (${blocked.join(', ')})` : ''}`
      })()
  const burns = Object.keys(opts.tokens)
    .filter((id) => /^[A-Z][A-Z0-9]*-\d+$/.test(id))
    .map((id) => [id, grandTotal(opts.tokens, id)] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  return [
    `## Factory state — live from the brain (you run on a worker and cannot see any of this otherwise)`,
    `- Status: ${opts.paused ? 'PAUSED' : 'running'}`,
    stuckLine,
    `- Top token burns: ${burns.length ? burns.map(([id, n]) => `${id} ${tok(n)}`).join(', ') : 'none tracked'}`,
    `- Recent brain warnings / errors / deadlocks (daemon.log tail):`,
    ...(opts.warnings.length ? opts.warnings.map((l) => `    ${l}`) : ['    (none recently — factory healthy)']),
    ``,
  ].join('\n')
}

// The pool. Each configured role runs on its own cadence with a persistent thread (resumed each run so it remembers
// what it filed) and its own model, filing tickets through the Linear tool. A role pins to a worker (round-robin, or
// the one holding its thread) and does NOT count against the per-ticket cap — roles are few and infrequent.
export function createRolePool(getCfg: () => Config, state: PersistedState, placement: Placement, getPaused: () => boolean, getLastBoard: () => Issue[], getPollHealth: () => PollHealth = () => ({ failureStreak: 0, lastError: null, lastOkAt: Date.now() })) {
  const roleRunning = new Map<string, RoleEntry>() // role name → its current run (the pool — ambient agents)

  const roleHostFor = (role: Role, i: number): string | null => {
    const held = state.threadRecs.get(`role:${role.name}`)?.host
    if (held && placement.hosts().includes(held)) return held
    const hs = placement.hosts()
    return hs.length ? (hs[i % hs.length] ?? null) : null
  }

  // A role's live daily budget — the tool calls remaining()/record() during a run, so the cap holds within a run, across
  // runs, and across restarts. limit null (no max_per_day) = unlimited, no enforcement.
  const makeQuota = (role: Role): RoleQuota => ({
    limit: role.maxPerDay,
    remaining: () => (role.maxPerDay == null ? Infinity : Math.max(0, role.maxPerDay + state.grantedToday(role.name) - state.countToday(role.name))),
    record: () => {
      const day = utcDay()
      const r = state.roleQuota.get(role.name)
      if (r && r.day === day) r.count++
      else state.roleQuota.set(role.name, { day, count: 1 })
      state.saveQuota()
    },
  })

  // The brain's live operational state, rendered into a pool role's prompt — a worker VM can't see any of this (the
  // daemon log, token burns, what's stuck), so the mechanic especially gets it first-class instead of guessing.
  const brainDigest = (): string => {
    return renderBrainDigest({
      board: getLastBoard(),
      paused: getPaused(),
      tokens: state.tokens,
      warnings: recentLogs().filter((l) => /WARN|deadlock|timed out|not authenticated|unauthorized|✗|429|rate.?limit|auth/i.test(l)).slice(-12),
      pollHealth: getPollHealth(),
      pollIntervalMs: getCfg().pollIntervalMs,
    })
  }

  const dispatchRole = (role: Role, i: number, force = false): void => {
    if (getPaused()) return // operator panic switch — no role runs while paused
    if (state.rolePaused.has(role.name)) return // this pooler is individually paused by the operator
    if (roleRunning.has(role.name)) return // last cadence's run still going — skip this tick
    const quota = makeQuota(role)
    if (!force && quota.remaining() <= 0) {
      log(`◆ role ${role.name} skip — daily quota reached (${role.maxPerDay}/${role.maxPerDay}); resumes at UTC midnight`)
      return
    }
    const host = roleHostFor(role, i)
    if (!state.logs.has(role.name)) state.logs.set(role.name, [])
    const acc = ((state.tokens[role.name] ??= {}).pool ??= zeroCounts())
    // Same fix as ticket dispatch: seed tokenBase from the resumed thread's last-folded total, not zero.
    const resumingThreadId = state.threadRecs.get(`role:${role.name}`)?.threadId ?? null
    const priorTokenBase = state.threadRecs.get(`role:${role.name}`)?.lastTokenBase ?? null
    let tokenBaseSeeded = false
    const entry: RoleEntry = { handle: undefined as unknown as RoleHandle, activity: 'starting…', host, tokenBase: zeroCounts() }
    roleRunning.set(role.name, entry)
    log(`◆ role ${role.name} run${host ? ` @ ${host}` : ''}`)
    entry.handle = startRole(
      getCfg(),
      role,
      host,
      (e) => {
        if (e.label != null) entry.activity = e.label
        if (e.log != null) {
          const a = state.logs.get(role.name)
          if (a) {
            a.push(e.log)
            if (a.length > 600) a.splice(0, a.length - 600)
            state.saveLogs()
          }
        }
        if (e.threadId) {
          if (!tokenBaseSeeded) {
            tokenBaseSeeded = true
            entry.tokenBase = resolveTokenBase(e.threadId, resumingThreadId, priorTokenBase)
          }
          state.threadRecs.set(`role:${role.name}`, { threadId: e.threadId, host, lastTokenBase: entry.tokenBase })
          state.saveThreads()
        }
        if (e.tokens) {
          foldDelta(acc, e.tokens, entry.tokenBase)
          entry.tokenBase = e.tokens
          state.saveTokens()
          const rec = state.threadRecs.get(`role:${role.name}`)
          if (rec) { state.threadRecs.set(`role:${role.name}`, { ...rec, lastTokenBase: e.tokens }); state.saveThreads() }
        }
      },
      state.threadRecs.get(`role:${role.name}`)?.threadId ?? null,
      quota,
      brainDigest(),
    )
    void entry.handle.done.then((o) => {
      roleRunning.delete(role.name)
      state.roleLast.set(role.name, Date.now())
      state.saveRoleLast()
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
      host: e?.host ?? state.threadRecs.get(`role:${role.name}`)?.host ?? null,
      tokens: state.tokens[role.name]?.pool?.total ?? 0,
      cadenceMs: role.cadenceMs,
      lastRunAt: state.roleLast.get(role.name) ?? null,
      filedToday: state.countToday(role.name),
      maxPerDay: role.maxPerDay,
      granted: state.grantedToday(role.name),
      paused: state.rolePaused.has(role.name),
    }
  }

  const stopAll = (): void => {
    for (const [, e] of roleRunning) e.handle.stop()
  }

  return { roleRunning, dispatchRole, roleItem, brainDigest, stopAll, roleWorkspaceKey }
}
