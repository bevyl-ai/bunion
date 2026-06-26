import { exec } from './proc'
import type { Config } from './config'
import type { Workspace } from './git'

export interface BackpressureResult {
  ok: boolean
  log: string
}

// The cheap, fast gate the runner enforces in the worktree before a PR exists — typecheck, affected tests, lint,
// whatever you configure. Fails closed on the first non-zero command. This is local backpressure only; the real
// merge gate (CI, integration lane, preview, review) lives on the PR.
export function backpressure(cfg: Config, ws: Workspace): BackpressureResult {
  for (const cmd of cfg.backpressure) {
    const parts = cmd.split(/\s+/).filter(Boolean)
    const bin = parts[0]
    if (!bin) continue
    const r = exec(bin, parts.slice(1), { cwd: ws.dir, timeoutMs: 900_000 })
    if (!r.ok) return { ok: false, log: `\`${cmd}\` failed:\n${r.combined.trim().slice(-1500)}` }
  }
  return { ok: true, log: '' }
}
