#!/usr/bin/env bun
import { loadConfig } from './config'
import { runById } from './runner'
import { initState } from './state'

// The entrypoint baked into the VM image. Runs one ticket and prints the result as a single trailing JSON line for
// the exedev worker to parse. Keep stdout otherwise quiet so that line is unambiguous.
const id = process.argv[2]
if (!id) {
  console.error('usage: bunion-runner <BEV-123>')
  process.exit(2)
}

const cfg = loadConfig()
initState(cfg.stateDb)
const result = await runById(cfg, id)
console.log(JSON.stringify(result))
process.exit(result.ok ? 0 : 1)
