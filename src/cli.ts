#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startAgent } from './agent-runner'
import { loadConfig, validateConfig } from './config'
import { fetchById, fetchCandidates } from './linear'
import { start } from './orchestrator'
import { readJson } from './persist'
import { have } from './proc'
import { apiCost, planCost, zeroCounts, type TokenTally } from './tokens'
import type { TokenCounts } from './types'

const HELP = `bunion — a Bun/TS port of OpenAI's Symphony. A thin harness that drives Codex (app-server) to ship Linear tickets.

usage:
  bunion start [path/to/WORKFLOW.md]   run the daemon: poll active states, drive each ticket via Codex
  bunion run <BEV-123>                 run one worker session for a ticket now (testing)
  bunion status                        issues per active state (the board)
  bunion doctor                        check tools + env + that WORKFLOW.md loads
  bunion tokens [path]                 token spend by stage + task (reads ~/.bunion/tokens.json)

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
      const outcome = await startAgent(cfg, issue, null, host, (e) => e.log && console.error(e.log), null, () => null).done
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
        console.log(`ok       WORKFLOW.md (scope=${cfg.tracker.team ?? cfg.tracker.projectSlug}, repo=${cfg.repo})`)
      } catch (e) {
        console.log(`MISSING  WORKFLOW.md — ${e instanceof Error ? e.message : e}`)
      }
      return
    }

    case 'tokens': {
      // Where the factory's tokens went, from the persisted tally (identifier → phase → counts): totals BY STAGE
      // (pipeline phase) and BY TASK (ticket / pool role). Cumulative since the tally last reset, NOT per-day.
      const path = arg ?? join(homedir(), '.bunion', 'tokens.json')
      const tally = readJson<TokenTally>(path, {})
      if (Object.keys(tally).length === 0) {
        console.log(`no token data at ${path}`)
        return
      }
      const add = (a: TokenCounts, b: TokenCounts): void => {
        a.total += b.total
        a.input += b.input
        a.output += b.output
        a.cached += b.cached
        a.reasoning += b.reasoning
      }
      const byPhase = new Map<string, TokenCounts>()
      const tickets: { id: string; c: TokenCounts }[] = []
      const roles: { id: string; c: TokenCounts }[] = []
      const grand = zeroCounts()
      const TICKET = /^[A-Z][A-Z0-9]*-\d+$/ // a ticket identifier (BEV-123) vs a pool-role name (mechanic / dreamer)
      for (const [key, phases] of Object.entries(tally)) {
        const kt = zeroCounts()
        for (const [phase, c] of Object.entries(phases)) {
          const acc = byPhase.get(phase) ?? zeroCounts()
          byPhase.set(phase, acc)
          add(acc, c)
          add(kt, c)
          add(grand, c)
        }
        ;(TICKET.test(key) ? tickets : roles).push({ id: key, c: kt })
      }
      const tok = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(0)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : `${n}`)
      const usd = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`
      const row = (label: string, c: TokenCounts): string => `  ${label.padEnd(13)} ${tok(c.total).padStart(8)} tok   ~${usd(apiCost(c)).padStart(8)} api`
      const cached = grand.input ? Math.round((grand.cached / grand.input) * 100) : 0
      console.log(`bunion token spend · ${path}`)
      console.log(`  Σ ${tok(grand.total)} tok · ~${usd(apiCost(grand))} api · ~${usd(planCost(grand))} on plan · ${cached}% cached · ${tickets.length} tickets, ${roles.length} roles\n`)
      console.log('BY STAGE')
      for (const [phase, c] of [...byPhase.entries()].sort((a, b) => b[1].total - a[1].total)) console.log(row(phase, c))
      console.log('\nTOP TASKS')
      for (const { id, c } of [...tickets].sort((a, b) => b.c.total - a.c.total).slice(0, 15)) console.log(row(id, c))
      if (roles.length > 0) {
        console.log('\nROLES')
        for (const { id, c } of [...roles].sort((a, b) => b.c.total - a.c.total)) console.log(row(id, c))
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
