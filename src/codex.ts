import { exec } from './proc'
import type { Config } from './config'
import type { ProcResult } from './types'

// One agent turn over the worktree. Mirrors stupify's invocation: the prompt goes on STDIN (dodges ARG_MAX), and
// Codex is sandboxed to the worktree with NO network. The runner owns all git/gh I/O, so a prompt-injected ticket
// can at worst leave a bad diff in the tree — caught by backpressure, review, and the human merge gate — and can
// never exfiltrate, reach a token, or run a network command.
export function runAgent(repoDir: string, prompt: string, cfg: Config): ProcResult {
  const args = [
    'exec',
    '--cd',
    repoDir,
    '--sandbox',
    'workspace-write',
    '-c',
    `model_reasoning_effort=${cfg.codexEffort}`,
    '-c',
    'sandbox_workspace_write.network_access=false',
    '-c',
    `sandbox_workspace_write.writable_roots=["${repoDir}","/tmp"]`,
  ]
  if (cfg.codexProvider) args.push('-c', `model_provider=${cfg.codexProvider}`)
  if (cfg.codexModel) args.push('-c', `model=${cfg.codexModel}`)
  args.push('-') // read the prompt from stdin
  return exec('codex', args, { cwd: repoDir, timeoutMs: cfg.codexTimeoutMs, input: prompt })
}
