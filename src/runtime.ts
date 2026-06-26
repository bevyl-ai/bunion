import { loadConfig } from './config'
import { resolveStates } from './linear'
import type { Runtime } from './types'

// Load config + resolve the configured state names to ids. One network round-trip; shared by the daemon, the CLI,
// and the per-VM runner so they all see the same resolved board.
export async function resolveRuntime(): Promise<Runtime> {
  const cfg = loadConfig()
  return { cfg, states: await resolveStates(cfg) }
}
