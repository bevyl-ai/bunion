import { expect, test } from 'bun:test'
import { pruneKeepByHost } from './orchestrator-prune'

// BEV-4061: the periodic VM workspace prune protected only TICKET workspaces — pool-role checkouts (role-mechanic
// etc.) were never on the keep list, so the sweep rm -rf'd them; a reused role workspace's top-level mtime goes
// stale even while codex works inside it, so a RUNNING mechanic's cwd could vanish under its shell commands. These
// prove role workspaces are now prune-protected exactly like tickets, under the exact dir key role-runner creates.
const HOSTS = ['vm-a', 'vm-b']

test('a role with a known host is kept there — under its literal role-<name> workspace dir key', () => {
  const keep = pruneKeepByHost(HOSTS, [], [], [{ name: 'mechanic', host: 'vm-a' }])
  expect(keep.get('vm-a')).toContain('role-mechanic') // the on-disk contract: must match role-runner's wsKey
  expect(keep.get('vm-b') ?? []).not.toContain('role-mechanic')
})

test('a role with NO host record (never dispatched, or its thread pre-dates host tracking) is kept on EVERY host', () => {
  const keep = pruneKeepByHost(HOSTS, [], [], [{ name: 'dreamer', host: null }])
  for (const h of HOSTS) expect(keep.get(h)).toContain('role-dreamer')
})

test('ticket protection is unchanged: pinned tickets kept on their worker only, host-unknown board tickets kept everywhere', () => {
  const keep = pruneKeepByHost(HOSTS, [{ identifier: 'BEV-1', host: 'vm-b' }], [{ identifier: 'BEV-2', host: null }], [])
  expect(keep.get('vm-b')).toContain('BEV-1')
  expect(keep.get('vm-a') ?? []).not.toContain('BEV-1')
  for (const h of HOSTS) expect(keep.get(h)).toContain('BEV-2')
})
