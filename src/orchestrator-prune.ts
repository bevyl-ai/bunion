import { spawn } from 'node:child_process'
import { roleWorkspaceKey } from './role-runner'
import { log } from './log'

// BEV-4061: the keep-list computation behind the periodic VM workspace prune (§8.6), pure + exported so it's
// unit-testable. The sweep deletes any ~/.bunion/workspaces dir NOT on its host's list, so an omission here IS a
// deletion — exactly how pool-role checkouts (`role-<name>`) were being destroyed: they were never on the list, and
// a reused role workspace's top-level mtime goes stale even while codex works INSIDE it, so the sweep rm -rf'd a
// running mechanic's cwd out from under its shell commands, sidestepping the BEV-3970/3971 start-of-run self-heal
// entirely. Roles are now protected exactly like tickets: kept on the host we believe holds the checkout, or on
// EVERY host when there's no record (never dispatched / no persisted thread — the same safe fallback board tickets get).
export function pruneKeepByHost(
  hosts: string[],
  pinned: Array<{ identifier: string; host: string }>, // live runs + scheduled retries — keep on their pinned worker
  board: Array<{ identifier: string; host: string | null }>, // every open ticket; host=null → no record
  roles: Array<{ name: string; host: string | null }>, // configured pool roles; host = live run's, else the persisted thread's
): Map<string, string[]> {
  const keepByHost = new Map<string, string[]>()
  const keep = (h: string, id: string): void => {
    keepByHost.set(h, [...(keepByHost.get(h) ?? []), id])
  }
  const spread = (id: string, host: string | null): void => {
    if (host) keep(host, id)
    else for (const h of hosts) keep(h, id)
  }
  for (const p of pinned) keep(p.host, p.identifier)
  for (const b of board) spread(b.identifier, b.host)
  for (const r of roles) spread(roleWorkspaceKey(r.name), r.host)
  return keepByHost
}

// Periodic workspace hygiene: each ticket's checkout is ~5-6G (node_modules + git history), and stale ones pile
// up as tickets cycle across VMs (every restart re-pins and orphans the old copy). Prune workspaces on each VM
// that aren't currently pinned there AND haven't been touched in 20min. Fire-and-forget; never blocks the loop.
export function pruneWorkspaces(hosts: string[], pinned: Array<{ identifier: string; host: string }>, board: Array<{ identifier: string; host: string | null }>, roles: Array<{ name: string; host: string | null }>): void {
  if (hosts.length === 0) return
  const keepByHost = pruneKeepByHost(hosts, pinned, board, roles)
  for (const host of hosts) {
    const list = `${(keepByHost.get(host) ?? []).join(' ')} SMOKE CLONETEST`
    const cmd = `for d in ~/.bunion/workspaces/*/; do [ -d "$d" ] || continue; id=$(basename "$d"); case " ${list} " in *" $id "*) continue;; esac; [ -z "$(find "$d" -maxdepth 0 -mmin -20 2>/dev/null)" ] && rm -rf "$d"; done`
    spawn('ssh', ['-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', host, cmd], { stdio: 'ignore' }).on('error', () => {})
  }
  log(`workspace prune swept ${hosts.length} VM(s)`)
}
