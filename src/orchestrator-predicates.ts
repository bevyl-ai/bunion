import { phaseOf } from './config'
import type { Config, Issue } from './types'

// Pure per-ticket predicates over the tracker state, shared by dispatch, the deadlock sweep, and the dashboard
// snapshot builder — one definition of "active"/"terminal"/"routable"/"blocked" instead of three.

export const norm = (s: string): string => s.trim().toLowerCase()

export const isTerminal = (cfg: Config, s: string): boolean => cfg.tracker.terminalStates.some((t) => norm(t) === norm(s))
export const isActive = (cfg: Config, s: string): boolean => cfg.tracker.activeStates.some((t) => norm(t) === norm(s))

function inOptInProject(cfg: Config, i: Issue): boolean {
  const project = i.project
  return project != null && cfg.tracker.optInProjects.some((p) => p === norm(project.id) || p === norm(project.slugId ?? ''))
}

// Opt-in gate (Symphony §4.1.1), augmented: a ticket enters if it's delegated to the factory's own app actor OR
// carries every required label OR belongs to a configured opt-in project. Delegation is Linear's assign-an-app
// mechanism (it sets `delegate`, not `assignee`, for apps).
export const isRoutable = (cfg: Config, i: Issue): boolean =>
  (cfg.tracker.appActorId != null && i.delegateId === cfg.tracker.appActorId) ||
  inOptInProject(cfg, i) ||
  cfg.tracker.requiredLabels.every((l) => i.labels.some((x) => norm(x) === l))

export const planBlocked = (cfg: Config, i: Issue): boolean => phaseOf(cfg, i.state) === 'plan' && i.blockers.some((b) => b.state == null || !isTerminal(cfg, b.state))
