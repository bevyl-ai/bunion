import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exec } from './proc'
import type { Config } from './types'

export interface HookResult {
  ok: boolean
  error?: string
}

// <root>/<sanitized-identifier>, validated to live strictly under the root.
export function workspaceDir(cfg: Config, identifier: string): string {
  const key = (identifier || 'issue').replace(/[^A-Za-z0-9._-]/g, '_')
  const dir = resolve(join(cfg.workspaceRoot, key))
  const root = resolve(cfg.workspaceRoot)
  if (dir === root) throw new Error('workspace equals root')
  if (!dir.startsWith(root + '/')) throw new Error('workspace outside root')
  return dir
}

// Existing dir → reuse (created=false, after_create does NOT re-run). A non-dir at the path is replaced.
export function ensureWorkspace(cfg: Config, identifier: string): { dir: string; created: boolean } {
  const dir = workspaceDir(cfg, identifier)
  mkdirSync(cfg.workspaceRoot, { recursive: true })
  if (existsSync(dir)) {
    if (statSync(dir).isDirectory()) return { dir, created: false }
    rmSync(dir, { recursive: true, force: true })
  }
  mkdirSync(dir, { recursive: true })
  return { dir, created: true }
}

export function removeWorkspace(cfg: Config, identifier: string): void {
  let dir: string
  try {
    dir = workspaceDir(cfg, identifier)
  } catch {
    return
  }
  if (cfg.hooks.beforeRemove && existsSync(dir)) runHook(cfg, dir, 'before_remove', cfg.hooks.beforeRemove) // failure ignored
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

export function runHook(cfg: Config, dir: string, name: string, script: string): HookResult {
  const r = exec('sh', ['-lc', script], { cwd: dir, timeoutMs: cfg.hooks.timeoutMs })
  return r.ok ? { ok: true } : { ok: false, error: `${name} hook failed:\n${r.combined.trim().slice(-800)}` }
}

const SKILLS_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills')

// Copy bunion's bundled skills into the workspace so the agent has linear/commit/push/pull/land. Run AFTER the
// after_create hook (which clones the target repo), so the skills sit beside the repo's own .codex if any.
export function installSkills(dir: string): void {
  if (!existsSync(SKILLS_SRC)) return
  const dest = join(dir, '.codex', 'skills')
  mkdirSync(dest, { recursive: true })
  cpSync(SKILLS_SRC, dest, { recursive: true })
}
