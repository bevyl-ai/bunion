import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { ensureWorkspace } from './workspace'
import type { Config } from './types'

let root: string
let cfg: Config

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bunion-ws-test-'))
  cfg = { workspaceRoot: root } as Config
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('fresh ticket → created, fresh dir with no .git', () => {
  const r = ensureWorkspace(cfg, 'BEV-1', null)
  expect(r.created).toBe(true)
  expect(existsSync(r.dir)).toBe(true)
})

test('a valid existing checkout (.git present) → reused, NOT recreated', () => {
  const first = ensureWorkspace(cfg, 'BEV-2', null)
  mkdirSync(join(first.dir, '.git'), { recursive: true }) // simulate a completed clone
  writeFileSync(join(first.dir, 'marker.txt'), 'keep me')
  const second = ensureWorkspace(cfg, 'BEV-2', null)
  expect(second.created).toBe(false)
  expect(existsSync(join(second.dir, 'marker.txt'))).toBe(true) // proves it was NOT wiped
})

// BEV-3970/3971: a worktree's cwd can go stale out from under a running ticket — the directory survives but its
// `.git` is gone (the underlying main checkout was reset/reclaimed). Reusing that dir blindly is exactly what
// produced `invalid_workspace_cwd` forever; ensureWorkspace must instead treat it as needing recreation.
test('a directory with NO .git (stale/broken worktree) → wiped and recreated, not silently reused', () => {
  const first = ensureWorkspace(cfg, 'BEV-3', null)
  writeFileSync(join(first.dir, 'stale-leftover.txt'), 'from a dead worktree')
  const second = ensureWorkspace(cfg, 'BEV-3', null)
  expect(second.created).toBe(true)
  expect(existsSync(join(second.dir, 'stale-leftover.txt'))).toBe(false) // proves it WAS wiped
})

// BEV-4061: a pool role reuses ONE persistent workspace (`role-<name>`) across cadence runs. When it vanishes out
// from under the pool (a VM reset, or the pre-fix prune sweep eating it — even mid-run), the next run must flow
// through the exact BEV-3970 self-heal tickets get: created=true, so role-runner re-runs after_create (fresh clone)
// + installSkills instead of handing codex a missing cwd. The literal key pins the on-disk contract with role-runner.
test('a vanished role workspace (role-mechanic) → recreated with created=true so the clone + skills re-run', () => {
  const first = ensureWorkspace(cfg, 'role-mechanic', null)
  mkdirSync(join(first.dir, '.git'), { recursive: true }) // simulate the completed clone of a prior cadence run
  rmSync(first.dir, { recursive: true, force: true }) // the workspace disappears between runs
  const again = ensureWorkspace(cfg, 'role-mechanic', null)
  expect(again.created).toBe(true)
  expect(existsSync(again.dir)).toBe(true)
})

test('a non-directory at the path → replaced with a fresh dir', () => {
  const dir = join(root, 'BEV-4')
  mkdirSync(root, { recursive: true })
  writeFileSync(dir, 'not a directory')
  const r = ensureWorkspace(cfg, 'BEV-4', null)
  expect(r.created).toBe(true)
  expect(existsSync(join(r.dir, '.git'))).toBe(false)
})
