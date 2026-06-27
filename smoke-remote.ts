// Temp smoke: drive ONE codex turn on a worker VM through bunion's real remote path. No Linear, no clone, no PR.
// Usage: bun smoke-remote.ts <ssh-host>
import { AppServerSession } from './src/codex/app-server'
import { loadConfig } from './src/config'
import { ensureWorkspace, removeWorkspace } from './src/workspace'

const host = process.argv[2]
if (!host) throw new Error('usage: bun smoke-remote.ts <ssh-host>')

const cfg = loadConfig()
const onEvent = (e: { turn?: number; label?: string; log?: string }) => {
  if (e.log) console.log('  ·', e.log.replace(/\n/g, ' ').slice(0, 160))
}

const { dir, created } = ensureWorkspace(cfg, 'SMOKE', host)
console.log(`workspace on ${host}: ${dir} (created=${created})`)

const session = new AppServerSession(cfg, [], onEvent)
try {
  await session.start(dir, host)
  console.log('app-server: initialized over ssh ✓')
  const threadId = await session.startThread(dir)
  console.log('thread:', threadId)
  await session.runTurn(threadId, dir, 'Reply with exactly: BUNION_OK and nothing else. Do not run any commands.', 'smoke')
  console.log('turn: completed ✓ (model answered through the exe-llm gateway)')
  console.log('\nSMOKE_PASS')
} catch (e) {
  console.log('\nSMOKE_FAIL:', e instanceof Error ? e.message : String(e))
  process.exitCode = 1
} finally {
  session.stop()
  removeWorkspace(cfg, 'SMOKE', host)
}
