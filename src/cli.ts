#!/usr/bin/env bun
import { loadConfig } from './config'
import { fetchIssue } from './linear'
import { have } from './proc'
import { initState, listRuns } from './state'
import { getWorker } from './worker'
import { start } from './orchestrator'

const HELP = `bunion — a Bun/TS port of OpenAI's Symphony. Point it at a repo + Linear project and it ships simple tickets.

usage:
  bunion start                    run the daemon: poll Linear → ship eligible tickets
  bunion run <BEV-123> [opts]     run one ticket now
       --dry                      prepare the worktree, skip the agent (smoke test wiring)
       --exedev                   use the exe.dev per-VM worker instead of local
  bunion status                   recent runs from the local state db
  bunion doctor                   check required tools + env

config lives in .env — see .env.example`

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)

  switch (cmd) {
    case 'start':
      return start()

    case 'run': {
      const id = rest.find((a) => !a.startsWith('-'))
      if (!id) throw new Error('usage: bunion run <BEV-123> [--dry] [--exedev]')
      if (rest.includes('--dry')) process.env.DRY_RUN = '1'
      if (rest.includes('--exedev')) process.env.PROVIDER = 'exedev'
      const cfg = loadConfig()
      initState(cfg.stateDb)
      const r = await getWorker(cfg).run(await fetchIssue(cfg, id))
      console.log(JSON.stringify(r, null, 2))
      process.exit(r.ok ? 0 : 1)
    }

    case 'status': {
      const cfg = loadConfig()
      initState(cfg.stateDb)
      const runs = listRuns()
      if (runs.length === 0) console.log('(no runs yet)')
      for (const r of runs) {
        console.log(`${r.identifier.padEnd(12)} ${r.status.padEnd(10)} ${r.prUrl ?? r.detail ?? ''}`)
      }
      return
    }

    case 'doctor': {
      for (const t of ['bun', 'git', 'gh', 'codex'] as const) console.log(`${have(t) ? 'ok      ' : 'MISSING '}${t}`)
      for (const e of ['REPO', 'LINEAR_API_KEY', 'LINEAR_TEAM']) console.log(`${process.env[e] ? 'ok      ' : 'MISSING '}${e}`)
      return
    }

    default:
      console.log(HELP)
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
