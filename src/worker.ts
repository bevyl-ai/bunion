import { runIssue } from './runner'
import type { Config } from './config'
import type { Issue, RunnerResult, Worker } from './types'

// Runs the pipeline in-process, in a per-ticket worktree on this host. Isolation = the per-ticket checkout + the
// Codex sandbox (no network, writes scoped to the worktree). This is stupify's model and needs no extra infra.
export function localWorker(cfg: Config): Worker {
  return { kind: 'local', run: (issue) => runIssue(cfg, issue) }
}

// Boots a fresh exe.dev VM per ticket for hard isolation, runs `bunion-runner <id>` on it, reads the trailing JSON
// line of stdout, tears the VM down. Wire your exe.dev VM API into the three marked spots; the rest is the same
// pipeline (the VM image just needs git, gh, codex, bun + the Codex/exe.dev config baked in).
export function exedevWorker(_cfg: Config): Worker {
  return {
    kind: 'exedev',
    async run(_issue: Issue): Promise<RunnerResult> {
      // 1. const vm = await exedev.create({ image: process.env.RUNNER_IMAGE ?? 'bunion-runner' })
      // 2. const out = await exedev.exec(vm, ['bunion-runner', issue.identifier])
      //    then: JSON.parse(out.trim().split('\n').pop()!) as RunnerResult
      // 3. finally: await exedev.destroy(vm)
      throw new Error('exedev worker not wired — set PROVIDER=local, or implement create/exec/destroy against your exe.dev API in src/worker.ts')
    },
  }
}

export function getWorker(cfg: Config): Worker {
  return (process.env.PROVIDER ?? 'local') === 'exedev' ? exedevWorker(cfg) : localWorker(cfg)
}
