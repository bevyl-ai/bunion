import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from './proc'
import type { Config } from './config'
import type { Issue } from './types'

export interface Workspace {
  dir: string
  branch: string
}

// Fresh shallow checkout of the base branch on a working branch. Clone via `gh` so private repos + the exe.dev
// integration's auth work — a plain `git clone` has no credentials and fails on anything private.
export function prepareWorkspace(cfg: Config, issue: Issue): Workspace {
  const dir = join(cfg.workdir, issue.identifier)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(cfg.workdir, { recursive: true })

  const clone = exec('gh', ['repo', 'clone', cfg.slug, dir, '--', '--depth', '1', '--branch', cfg.baseBranch, '-q'])
  if (!clone.ok) throw new Error(`clone failed (is gh authed for ${cfg.slug}?): ${tail(clone.combined)}`)

  const branch = `factory/${issue.identifier}`
  const co = exec('git', ['checkout', '-b', branch], { cwd: dir })
  if (!co.ok) throw new Error(`branch failed: ${tail(co.combined)}`)
  return { dir, branch }
}

export function hasChanges(ws: Workspace): boolean {
  return exec('git', ['status', '--porcelain'], { cwd: ws.dir }).stdout.trim().length > 0
}

// Commit the agent's edits, push the branch, open the PR. Returns the PR url. All gh I/O lives here, never in the
// agent — that is the boundary that makes a poisoned ticket harmless.
export function publish(cfg: Config, ws: Workspace, issue: Issue): string {
  exec('git', ['add', '-A'], { cwd: ws.dir })
  const title = `${issue.identifier}: ${issue.title}`
  const commit = exec('git', ['-c', 'user.name=bunion', '-c', 'user.email=bunion@local', 'commit', '-m', title], {
    cwd: ws.dir,
  })
  if (!commit.ok) throw new Error(`commit failed: ${tail(commit.combined)}`)

  const push = exec('git', ['push', '-u', 'origin', ws.branch], { cwd: ws.dir })
  if (!push.ok) throw new Error(`push failed: ${tail(push.combined)}`)

  ensureLabel(cfg)
  const pr = exec(
    'gh',
    ['pr', 'create', '--repo', cfg.slug, '--head', ws.branch, '--base', cfg.baseBranch, '--title', title, '--body', body(issue), '--label', cfg.label],
    { cwd: ws.dir },
  )
  if (!pr.ok) throw new Error(`pr create failed: ${tail(pr.combined)}`)
  return pr.stdout.trim().split('\n').pop() ?? '' // gh prints the PR url last
}

export function cleanup(ws: Workspace): void {
  if (existsSync(ws.dir)) rmSync(ws.dir, { recursive: true, force: true })
}

// gh hard-errors on `pr create --label` if the label doesn't exist on the repo — and that would fail only AFTER a
// full agent run + push. Create it idempotently first; gh exits non-zero if it already exists, which we ignore.
function ensureLabel(cfg: Config): void {
  exec('gh', ['label', 'create', cfg.label, '--repo', cfg.slug, '--color', 'BFD4F2', '--description', 'autonomous PR (bunion)'])
}

function body(issue: Issue): string {
  return `Autonomous PR for [${issue.identifier}](${issue.url}).\n\nOpened by bunion. Review before merge.`
}

function tail(s: string): string {
  return s.trim().slice(-400)
}
