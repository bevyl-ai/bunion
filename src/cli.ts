#!/usr/bin/env bun
import { startAgent } from './agent-runner'
import { loadConfig, validateConfig } from './config'
import { fetchById, fetchCandidates } from './linear'
import { start } from './orchestrator'
import { have } from './proc'

const HELP = `bunion — a Bun/TS port of OpenAI's Symphony. A thin harness that drives Codex (app-server) to ship Linear tickets.

usage:
  bunion start [path/to/WORKFLOW.md]   run the daemon: poll active states, drive each ticket via Codex
  bunion run <BEV-123>                 run one worker session for a ticket now (testing)
  bunion status                        issues per active state (the board)
  bunion doctor                        check tools + env + that WORKFLOW.md loads

config lives in WORKFLOW.md front matter — see the README.`

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  const arg = rest.find((a) => !a.startsWith('-'))

  switch (cmd) {
    case 'start':
      return start(arg)

    case 'run': {
      if (!arg) throw new Error('usage: bunion run <BEV-123>')
      const cfg = loadConfig()
      validateConfig(cfg)
      const issue = await fetchById(cfg, arg)
      const host = cfg.worker.sshHosts[0] ?? null // one-shot runs on the first configured worker VM, else local
      const outcome = await startAgent(cfg, issue, null, host, null, (e) => e.log && console.error(e.log)).done
      console.log(JSON.stringify(outcome, null, 2))
      process.exit(outcome.ok ? 0 : 1)
    }

    case 'status': {
      const cfg = loadConfig()
      validateConfig(cfg)
      const byState = new Map<string, string[]>()
      for (const i of await fetchCandidates(cfg)) byState.set(i.state, [...(byState.get(i.state) ?? []), i.identifier])
      for (const s of cfg.tracker.activeStates) {
        const ids = byState.get(s) ?? []
        console.log(`${s.padEnd(16)} ${String(ids.length).padStart(2)}  ${ids.join(' ')}`)
      }
      return
    }

    case 'doctor': {
      for (const t of ['bun', 'git', 'gh', 'codex', 'python3'] as const) console.log(`${have(t) ? 'ok      ' : 'MISSING '}${t}`)
      for (const e of ['LINEAR_API_KEY', 'LINEAR_TEAM', 'REPO']) console.log(`${process.env[e] ? 'ok      ' : 'MISSING '}${e}`)
      try {
        const cfg = loadConfig()
        validateConfig(cfg)
        console.log(`ok       WORKFLOW.md (scope=${cfg.tracker.team ?? cfg.tracker.projectSlug})`)
      } catch (e) {
        console.log(`MISSING  WORKFLOW.md — ${e instanceof Error ? e.message : e}`)
      }
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
