import type { Config, Issue } from './types'

// Pure per-ticket predicates over the tracker state, shared by dispatch, the deadlock sweep, and the dashboard
// snapshot builder — one definition of "active"/"terminal"/"routable"/"blocked" instead of three.

export const norm = (s: string): string => s.trim().toLowerCase()

export const isTerminal = (cfg: Config, s: string): boolean => cfg.tracker.terminalStates.some((t) => norm(t) === norm(s))
export const isActive = (cfg: Config, s: string): boolean => cfg.tracker.activeStates.some((t) => norm(t) === norm(s))

// Opt-in gate (Symphony §4.1.1), augmented: a ticket enters if it's delegated to the factory's own app actor OR
// carries every required label. Delegation is Linear's assign-an-app mechanism (it sets `delegate`, not `assignee`, for apps).
export const isRoutable = (cfg: Config, i: Issue): boolean =>
  (cfg.tracker.appActorId != null && i.delegateId === cfg.tracker.appActorId) ||
  cfg.tracker.requiredLabels.every((l) => i.labels.some((x) => norm(x) === l))

export const openBlockers = (i: Pick<Issue, 'blockers'>): Issue['blockers'] =>
  i.blockers.filter((b) => {
    const t = b.stateType?.trim().toLowerCase()
    return t !== 'completed' && t !== 'canceled'
  })

export const dispatchBlocked = (i: Pick<Issue, 'blockers'>): boolean => openBlockers(i).length > 0
