import { homedir } from 'node:os'
import { join } from 'node:path'
import { flushAllPending, readJson, throttledWriter, writeJson } from './persist'
import { grandTotal, type TokenTally } from './tokens'
import type { Config, Issue, TokenCounts } from './types'

const norm = (s: string): string => s.trim().toLowerCase()
const LOG_TICKETS = 200 // most-recent tickets whose transcript we keep in memory + persist — BEV ergonomics audit:
// 60 was comfortably smaller than a single day's board (81+ items and growing); bumped with real headroom.
// touchLog's eviction is also now state-aware (see below), so this is a backstop, not the primary defense.
// BEV ergonomics audit: pure recency eviction let a ticket that's actively awaiting a person (any human-action
// lane) lose its ENTIRE transcript just because other tickets churned more recently on a busy board — the
// dashboard then shows "(no log yet)", indistinguishable from "never ran," on exactly the tickets a person most
// needs history on (BEV-3869: 75h stuck, 6.31B tokens of real history, 0 cached lines). Protect every lane a
// human acts on: the escalations (Needs Engineer / QA - blocked) and the review gates (QA - Requested /
// Factory - UI review / Factory - can't verify).
const PROTECTED_LOG_STATES = new Set(['factory - needs engineer', 'qa - blocked', 'qa - requested', 'factory - ui review', "factory - can't verify"])

// Every ~/.bunion/*.json file bunion persists, and the in-memory state loaded from (and re-saved, coalesced, to)
// each one. Consolidates what used to be ~15 separate readJson/throttledWriter pairs scattered through
// orchestrator.ts into one cohesive, typed unit — the daemon's entire durable-state surface in one place.

export const STATE_DIR = join(homedir(), '.bunion')
const TOKENS_FILE = join(STATE_DIR, 'tokens.json') // identifier → phase → token counts
const LOGS_FILE = join(STATE_DIR, 'logs.json') // identifier → recent transcript lines
const THREADS_FILE = join(STATE_DIR, 'threads.json') // issue.id / role:<name> → { threadId, host }
const QUOTA_FILE = join(STATE_DIR, 'role-quota.json') // role name → { day, count } — daily ticket-filing cap, persisted
const GRANTS_FILE = join(STATE_DIR, 'ticket-grants.json') // identifier → extra token budget granted on top of the hard cap, persisted
const ROLE_LAST_FILE = join(STATE_DIR, 'role-last.json') // role name → ms timestamp of its last completed run, persisted so a daemon restart doesn't re-fire every role within the first minute regardless of true cadence
const PAUSED_FILE = join(STATE_DIR, 'paused.json') // operator panic switch — { paused: bool }, persisted so a restart mid-incident stays paused
// issue.id → forward-progress clock, persisted so a restart doesn't reset every currently-active ticket's "since" to
// the restart moment — BEV audit: it wasn't, and every ticket still sitting in the same state hardStallMs (90min)
// after ANY restart got wrongly deadlocked in lockstep, with a Linear comment falsely claiming it had been looping,
// even for tickets that had never once been dispatched (simply capacity-starved the whole time).
const PROGRESS_FILE = join(STATE_DIR, 'progress.json')
const DEADLOCKED_FILE = join(STATE_DIR, 'deadlocked.json') // issue.id[] — first-offense memory for deadlock escalation, persisted for the same reason as PROGRESS_FILE
const ROLE_PAUSED_FILE = join(STATE_DIR, 'role-paused.json') // per-role pause — [name,…] poolers stopped independently of the global pause, persisted

// One codex thread per ticket / role, persisted (key → thread id + the worker holding its rollout) so the next
// phase and operator chat resume the same conversation, and a resume lands on the right worker after a restart.
export interface ThreadRec {
  threadId: string
  host: string | null
  lastTokenBase?: TokenCounts // last-folded thread-cumulative for THIS thread — seeds tokenBase on the next session that resumes it, so a redispatch doesn't re-fold the whole thread's history-to-date on top of what's already tallied
}
// A role's daily ticket-filing counter, persisted (role name → { day, count }) so the cap survives the frequent
// daemon restarts. `day` is a UTC date string, so the count resets at UTC midnight.
export interface QuotaRec {
  day: string
  count: number
  granted?: number // operator top-up for `day` — adds to the cap on demand; resets with the day like count
}
export interface ProgressRec {
  since: number
  tokensAtProgress: number
  seen: Set<string>
}
export interface TicketGrantAuditEntry {
  at: string
  source: string
  actor: string
  oldCap: number
  newCap: number
  increment: number
  rationale: string
}
export interface TicketGrantRecord {
  total: number
  audit: TicketGrantAuditEntry[]
}
export interface CapGrantPlan {
  ok: boolean
  oldCap: number
  newCap: number
  increment: number
  desiredCap: number
  deniedReason?: string
}

export function utcDay(): string {
  return new Date().toISOString().slice(0, 10)
}

export type PersistedState = ReturnType<typeof createPersistedState>

// Loads every persisted file once at startup and returns the live Maps/Sets plus their throttled save*() functions.
// `getCfg` is a live accessor (not a snapshot) because cfg is hot-reloaded every poll tick — effectiveCap must see
// the CURRENT deadlock.hardTokenCap, not whatever it was when the daemon booted.
export function createPersistedState(getCfg: () => Config, getLastBoard: () => Issue[]) {
  const tokens = readJson<TokenTally>(TOKENS_FILE, {}) // identifier → phase → cumulative token counts
  const saveTokens = throttledWriter(TOKENS_FILE, () => tokens)

  // One rolling transcript per ticket (LRU). NOT cleared on re-dispatch, so operator chat + prior phases survive a
  // continuation/handoff; `restart` clears it for a from-scratch run. `touchLog` marks a ticket most-recent and
  // evicts the oldest past the cap.
  const logs = new Map<string, string[]>(Object.entries(readJson<Record<string, string[]>>(LOGS_FILE, {})).filter(([, a]) => Array.isArray(a)))
  const saveLogs = throttledWriter(LOGS_FILE, () => Object.fromEntries(logs))
  const getLog = (identifier: string): string[] => logs.get(identifier) ?? []
  const touchLog = (identifier: string): void => {
    const prev = logs.get(identifier) ?? []
    logs.delete(identifier)
    logs.set(identifier, prev)
    if (logs.size > LOG_TICKETS) {
      // Evict the oldest-touched ticket that ISN'T one a human still needs to look at, not just the literal
      // oldest — walk in touch order (Map preserves insertion order) and skip protected states.
      for (const id of logs.keys()) {
        if (id === identifier) continue
        const state = norm(getLastBoard().find((i) => i.identifier === id)?.state ?? '')
        if (PROTECTED_LOG_STATES.has(state)) continue
        logs.delete(id)
        break
      }
    }
  }

  const threadRecs = new Map<string, ThreadRec>(Object.entries(readJson<Record<string, ThreadRec>>(THREADS_FILE, {})))
  const saveThreads = throttledWriter(THREADS_FILE, () => Object.fromEntries(threadRecs))

  // Persisted (unlike a plain in-memory Map) — BEV audit: it wasn't, so every restart reset every currently-active
  // ticket's clock to the restart moment, and any ticket still in the same state hardStallMs (90min) later got
  // wrongly auto-blocked in lockstep, including tickets that had never once been dispatched (just capacity-starved
  // the whole time) — the Linear comment it posts falsely claims looping happened.
  const progress = new Map<string, ProgressRec>(
    Object.entries(readJson<Record<string, { since: number; tokensAtProgress: number; seen: string[] }>>(PROGRESS_FILE, {})).map(
      ([id, p]) => [id, { since: p.since, tokensAtProgress: p.tokensAtProgress, seen: new Set(p.seen) }],
    ),
  )
  const saveProgress = throttledWriter(PROGRESS_FILE, () => Object.fromEntries([...progress].map(([id, p]) => [id, { since: p.since, tokensAtProgress: p.tokensAtProgress, seen: [...p.seen] }])))

  // First-offense memory: a SECOND deadlock on the same ticket escalates straight to Factory - Needs Engineer instead
  // of another QA - blocked triage cycle. Also persisted (same restart-reset bug as `progress` above) — a ticket's
  // real first offense must survive a restart, or its genuine second deadlock gets treated as a first offense again.
  const deadlocked = new Set<string>(readJson<string[]>(DEADLOCKED_FILE, []))
  const saveDeadlocked = throttledWriter(DEADLOCKED_FILE, () => [...deadlocked])

  const roleQuota = new Map<string, QuotaRec>(Object.entries(readJson<Record<string, QuotaRec>>(QUOTA_FILE, {})))
  const saveQuota = throttledWriter(QUOTA_FILE, () => Object.fromEntries(roleQuota))

  const roleLast = new Map<string, number>(Object.entries(readJson<Record<string, number>>(ROLE_LAST_FILE, {}))) // role name → last completed run (ms), persisted
  const saveRoleLast = throttledWriter(ROLE_LAST_FILE, () => Object.fromEntries(roleLast))

  // Per-ticket token-budget grants, persisted. Older state was identifier → number; normalize it to the audited
  // record shape on read so old grants still load, but every new raise records source/actor/rationale.
  const ticketGrants = new Map<string, TicketGrantRecord>(
    Object.entries(readJson<Record<string, unknown>>(GRANTS_FILE, {})).map(([identifier, value]) => [identifier, normalizeTicketGrantRecord(value)]),
  )
  const saveGrants = throttledWriter(GRANTS_FILE, () => Object.fromEntries(ticketGrants))
  const grantTotal = (identifier: string): number => ticketGrants.get(identifier)?.total ?? 0
  const effectiveCap = (identifier: string): number => Math.min(getCfg().deadlock.maxEffectiveTokenCap, getCfg().deadlock.hardTokenCap + grantTotal(identifier))
  const capGrantPlanFor = (identifier: string): CapGrantPlan => planCapGrant({
    currentTotal: grandTotal(tokens, identifier),
    currentEffectiveCap: effectiveCap(identifier),
    hardTokenCap: getCfg().deadlock.hardTokenCap,
    maxEffectiveTokenCap: getCfg().deadlock.maxEffectiveTokenCap,
  })
  const recordCapGrant = (identifier: string, plan: CapGrantPlan, source: string, actor: string, rationale: string): void => {
    if (!plan.ok) return
    const rec = ticketGrants.get(identifier) ?? { total: 0, audit: [] }
    rec.total += plan.increment
    rec.audit.push({ at: new Date().toISOString(), source, actor, oldCap: plan.oldCap, newCap: plan.newCap, increment: plan.increment, rationale })
    if (rec.audit.length > 50) rec.audit.splice(0, rec.audit.length - 50)
    ticketGrants.set(identifier, rec)
    saveGrants()
  }

  let paused = readJson<{ paused: boolean }>(PAUSED_FILE, { paused: false }).paused
  const savePaused = (v: boolean): void => writeJson(PAUSED_FILE, { paused: v })

  const rolePaused = new Set<string>(readJson<string[]>(ROLE_PAUSED_FILE, [])) // pool roles the operator has individually paused
  const saveRolePaused = (): void => writeJson(ROLE_PAUSED_FILE, [...rolePaused])

  const countToday = (name: string): number => {
    const r = roleQuota.get(name)
    return r && r.day === utcDay() ? r.count : 0
  }
  const grantedToday = (name: string): number => {
    const r = roleQuota.get(name)
    return r && r.day === utcDay() ? (r.granted ?? 0) : 0
  }

  return {
    tokens, saveTokens,
    logs, saveLogs, getLog, touchLog,
    threadRecs, saveThreads,
    progress, saveProgress,
    deadlocked, saveDeadlocked,
    roleQuota, saveQuota, countToday, grantedToday,
    roleLast, saveRoleLast,
    ticketGrants, saveGrants, effectiveCap, capGrantPlanFor, recordCapGrant,
    get paused() { return paused },
    setPaused(v: boolean) { paused = v; savePaused(v) },
    rolePaused, saveRolePaused,
  }
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function normalizeTicketGrantRecord(value: unknown): TicketGrantRecord {
  const numeric = finiteNonNegative(value)
  if (numeric != null) return { total: numeric, audit: [] }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { total: 0, audit: [] }
  const raw = value as Record<string, unknown>
  const total = finiteNonNegative(raw.total) ?? 0
  const audit = Array.isArray(raw.audit)
    ? raw.audit.flatMap((entry): TicketGrantAuditEntry[] => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
        const item = entry as Record<string, unknown>
        const oldCap = finiteNonNegative(item.oldCap)
        const newCap = finiteNonNegative(item.newCap)
        const increment = finiteNonNegative(item.increment)
        if (oldCap == null || newCap == null || increment == null) return []
        return [{
          at: typeof item.at === 'string' ? item.at : '',
          source: typeof item.source === 'string' ? item.source : 'unknown',
          actor: typeof item.actor === 'string' ? item.actor : 'unknown',
          oldCap,
          newCap,
          increment,
          rationale: typeof item.rationale === 'string' ? item.rationale : '',
        }]
      })
    : []
  return { total, audit }
}

// Grants may raise a ticket above the normal hard cap, but never above the global max effective cap. If the capped
// raise would still leave current spend at/over cap, refuse it instead of creating a silent multi-billion cap.
export function planCapGrant(params: {
  currentTotal: number
  currentEffectiveCap: number
  hardTokenCap: number
  maxEffectiveTokenCap: number
}): CapGrantPlan {
  const oldCap = Math.min(params.currentEffectiveCap, params.maxEffectiveTokenCap)
  const desiredCap = Math.max(oldCap + params.hardTokenCap, params.currentTotal + params.hardTokenCap)
  const newCap = Math.min(desiredCap, params.maxEffectiveTokenCap)
  const increment = Math.max(0, newCap - oldCap)
  if (increment <= 0 || params.currentTotal >= newCap) {
    return {
      ok: false,
      oldCap,
      newCap: oldCap,
      increment: 0,
      desiredCap,
      deniedReason: `current spend ${Math.round(params.currentTotal / 1e6)}M would require ${Math.round(desiredCap / 1e6)}M cap, above max ${Math.round(params.maxEffectiveTokenCap / 1e6)}M`,
    }
  }
  return { ok: true, oldCap, newCap, increment, desiredCap }
}

export { flushAllPending }
