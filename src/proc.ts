import { spawnSync } from 'node:child_process'
import type { ProcResult } from './types'

// One synchronous subprocess. The large agent prompt is passed on stdin (`input`) rather than argv to dodge
// ARG_MAX (E2BIG). spawnSync surfaces a timeout via `signal` and a spawn failure via `error`, both with empty
// stdout/stderr — fold those into `combined` so a failure path shows the real cause, not "no output".
export function exec(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; input?: string } = {},
): ProcResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input ?? '',
    timeout: opts.timeoutMs,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const stdout = r.stdout ?? ''
  let combined = stdout + (r.stderr ?? '')
  if (r.signal) combined += `\n${cmd}: killed by ${r.signal}${opts.timeoutMs ? ` (timeout ${opts.timeoutMs}ms)` : ''}`
  if (r.error) combined += `\n${cmd}: ${r.error.message}`
  return { ok: r.status === 0 && r.error == null, stdout, combined }
}

export function have(cmd: string): boolean {
  return Bun.which(cmd) !== null
}
