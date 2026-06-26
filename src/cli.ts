#!/usr/bin/env bun
import { dispatch } from './dispatch'
import { fetchByStates, fetchIssue } from './linear'
import { have } from './proc'
import { resolveRuntime } from './runtime'
import { start } from './orchestrator'
import { getWorker } from './worker'

const HELP = `bunion — a Bun/TS port of OpenAI's Symphony. Point it at a repo + a Linear board and it ships simple tickets.

usage:
  bunion start                    run the daemon: poll the ready states → ship → review/escalate
  bunion run <BEV-123> [opts]     claim + run one ticket now
       --dry                      prepare the worktree, skip the agent (smoke test wiring)
       --exedev                   use the exe.dev per-VM worker instead of local
  bunion status                   live board: how many tickets in each bunion state
  bunion doctor                   check required tools + env

the gate is a Linear column: drop a ticket into a ready state and bunion takes it. config lives in .env.`

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
      const rt = await resolveRuntime()
      await dispatch(rt, getWorker(rt), await fetchIssue(rt.cfg, id))
      return
    }

    case 'status': {
      const rt = await resolveRuntime()
      const roles: [string, string[]][] = [
        ['ready', rt.states.ready],
        ['working', [rt.states.working]],
        ['in review', [rt.states.review]],
        ['needs human', [rt.states.escalate]],
      ]
      for (const [label, ids] of roles) {
        const issues = await fetchByStates(rt.cfg, ids)
        console.log(`${label.padEnd(12)} ${String(issues.length).padStart(2)}  ${issues.map((i) => i.identifier).join(' ')}`)
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
