import { runIssue } from './runner'
import type { Issue, Runtime, RunnerResult, Worker } from './types'

// Runs the pipeline in-process, in a per-ticket worktree on this host. Isolation = the per-ticket checkout + the
// Codex sandbox (no network, writes scoped to the worktree). This is stupify's model and needs no extra infra.
export function localWorker(rt: Runtime): Worker {
  return { kind: 'local', run: (issue) => runIssue(rt, issue) }
}

// Boots a fresh exe.dev VM per ticket for hard isolation, runs `bunion-runner <id>` on it, reads the trailing JSON
// line of stdout, tears the VM down. The host has already moved the ticket to the working state before this runs, so
// the runner's reconcile passes. Wire your exe.dev VM API into the three marked spots.
export function exedevWorker(_rt: Runtime): Worker {
  return {
    kind: 'exedev',
    async run(_issue: Issue): Promise<RunnerResult> {
      // 1. const vm = await exedev.create({ image: process.env.RUNNER_IMAGE ?? 'bunion-runner' })
      // 2. const out = await exedev.exec(vm, ['bunion-runner', issue.identifier]); JSON.parse(out.trim().split('\n').pop()!)
      // 3. finally: await exedev.destroy(vm)
      throw new Error('exedev worker not wired — set PROVIDER=local, or implement create/exec/destroy against your exe.dev API in src/worker.ts')
    },
  }
}

export function getWorker(rt: Runtime): Worker {
  return (process.env.PROVIDER ?? 'local') === 'exedev' ? exedevWorker(rt) : localWorker(rt)
}
