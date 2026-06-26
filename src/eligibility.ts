import type { Config } from './config'
import type { Issue, Verdict } from './types'

const no = (reason: string): Verdict => ({ ok: false, reason })

// The whole gate, decided BEFORE a worker spawns. Pure, deterministic, cheap. Carve-outs are absolute: a carve-out
// component is never autonomous regardless of label or estimate.
export function eligible(issue: Issue, cfg: Config): Verdict {
  if (!issue.labels.includes(cfg.label)) return no(`missing '${cfg.label}' label`)
  if (issue.estimate == null) return no('no estimate set')
  if (issue.estimate > cfg.maxEstimate) return no(`estimate ${issue.estimate} > max ${cfg.maxEstimate}`)
  const c = issue.component
  if (!c) return no('no `area:<x>` label — scope undeclared')
  if (cfg.carveOuts.includes(c)) return no(`'${c}' is a carve-out — never autonomous`)
  if (!cfg.allowlist.includes(c)) return no(`'${c}' not in allowlist`)
  if (issue.blocked) return no('blocked by an open dependency')
  return { ok: true }
}

export function autoMergeable(issue: Issue, cfg: Config): boolean {
  return issue.component != null && cfg.autoMerge.includes(issue.component)
}
