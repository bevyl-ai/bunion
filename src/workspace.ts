import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from './log'
import { exec } from './proc'
import { remoteHome, scpInto, shq, sshExec } from './ssh'
import type { Config } from './types'

export interface HookResult {
  ok: boolean
  error?: string
}

// A worker location: null = this machine (local fs + child processes), else an ssh host (an exe.dev VM) where the
// workspace, the clone, and codex all live. Every workspace op below branches on it.
export type Host = string | null

const key = (identifier: string): string => (identifier || 'issue').replace(/[^A-Za-z0-9._-]/g, '_')

// Local: <root>/<key>, validated to live strictly under the root. Remote: <vm-home>/.bunion/workspaces/<key>
// (a fixed root on the VM; workspace.root in config governs the LOCAL path only).
function workspaceDir(cfg: Config, identifier: string, host: Host): string {
  if (host) {
    const home = remoteHome(host)
    if (!home) throw new Error(`cannot resolve $HOME on ${host} (is it reachable over ssh?)`)
    return `${home}/.bunion/workspaces/${key(identifier)}`
  }
  const dir = resolve(join(cfg.workspaceRoot, key(identifier)))
  const root = resolve(cfg.workspaceRoot)
  if (dir === root) throw new Error('workspace equals root')
  if (!dir.startsWith(root + '/')) throw new Error('workspace outside root')
  return dir
}

// Existing dir → reuse (created=false, after_create does NOT re-run). A non-dir at the path is replaced.
export function ensureWorkspace(cfg: Config, identifier: string, host: Host): { dir: string; created: boolean } {
  const dir = workspaceDir(cfg, identifier, host)
  if (host) {
    const root = dir.slice(0, dir.lastIndexOf('/'))
    const r = sshExec(host, `mkdir -p ${shq(root)} && { [ -d ${shq(dir)} ] && echo BUNION_REUSE || { rm -rf ${shq(dir)}; mkdir -p ${shq(dir)} && echo BUNION_CREATED; }; }`)
    if (!r.ok) throw new Error(`ensureWorkspace on ${host}: ${r.out.trim().slice(-300)}`)
    return { dir, created: r.out.includes('BUNION_CREATED') }
  }
  mkdirSync(cfg.workspaceRoot, { recursive: true })
  if (existsSync(dir)) {
    if (statSync(dir).isDirectory()) return { dir, created: false }
    rmSync(dir, { recursive: true, force: true })
  }
  mkdirSync(dir, { recursive: true })
  return { dir, created: true }
}

export function removeWorkspace(cfg: Config, identifier: string, host: Host): void {
  let dir: string
  try {
    dir = workspaceDir(cfg, identifier, host)
  } catch {
    return
  }
  if (host) {
    if (cfg.hooks.beforeRemove) sshExec(host, `cd ${shq(dir)} 2>/dev/null && sh -lc ${shq(cfg.hooks.beforeRemove)}`) // failure ignored
    sshExec(host, `rm -rf ${shq(dir)}`)
    return
  }
  if (cfg.hooks.beforeRemove && existsSync(dir)) runHook(cfg, dir, 'before_remove', cfg.hooks.beforeRemove, null) // failure ignored
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

export function runHook(cfg: Config, dir: string, name: string, script: string, host: Host): HookResult {
  if (host) {
    const r = sshExec(host, `cd ${shq(dir)} && sh -lc ${shq(script)}`, cfg.hooks.timeoutMs)
    return r.ok ? { ok: true } : { ok: false, error: `${name} hook failed on ${host}:\n${r.out.trim().slice(-800)}` }
  }
  const r = exec('sh', ['-lc', script], { cwd: dir, timeoutMs: cfg.hooks.timeoutMs })
  return r.ok ? { ok: true } : { ok: false, error: `${name} hook failed:\n${r.combined.trim().slice(-800)}` }
}

const SKILLS_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills')

// Copy bunion's bundled skills into the workspace so the agent has linear/commit/push/pull/land. Run AFTER the
// after_create hook (which clones the target repo), so the skills sit beside the repo's own .codex if any.
export function installSkills(dir: string, host: Host): void {
  if (!existsSync(SKILLS_SRC)) return
  const dest = join(dir, '.codex', 'skills')
  if (host) {
    sshExec(host, `mkdir -p ${shq(dest)}`)
    const r = scpInto(SKILLS_SRC, host, dest)
    if (!r.ok) log(`warn: scp skills → ${host}: ${r.out.trim().slice(-200)}`)
    return
  }
  mkdirSync(dest, { recursive: true })
  cpSync(SKILLS_SRC, dest, { recursive: true })
}
