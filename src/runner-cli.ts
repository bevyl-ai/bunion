#!/usr/bin/env bun
import { fetchIssue } from './linear'
import { runIssue } from './runner'
import { resolveRuntime } from './runtime'

// The entrypoint baked into the VM image. The host has already moved the ticket to the working state and owns the
// settle; this just runs the pipeline and prints the result as a single trailing JSON line for the exedev worker to
// parse. Keep stdout otherwise quiet so that line is unambiguous.
const id = process.argv[2]
if (!id) {
  console.error('usage: bunion-runner <BEV-123>')
  process.exit(2)
}

const rt = await resolveRuntime()
const result = await runIssue(rt, await fetchIssue(rt.cfg, id))
console.log(JSON.stringify(result))
process.exit(result.ok ? 0 : 1)
