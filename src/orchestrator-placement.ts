import type { ThreadRec } from './orchestrator-state'
import type { Config } from './types'

export type Placement = ReturnType<typeof createPlacement>

// Worker placement. An issue is PINNED to one host for its whole life (continuation turns reuse the same VM so the
// cloned workspace + workpad survive). hostCounts = pinned issues per host; the pin is held until the issue is
// released (terminal / ineligible / hard-stop), NOT dropped between continuation turns.
export function createPlacement(getCfg: () => Config, threadRecs: Map<string, ThreadRec>) {
  const placement = new Map<string, string>() // issue.id → host
  const hostCounts = new Map<string, number>()
  const hosts = (): string[] => getCfg().worker.sshHosts

  const freePlacement = (id: string): void => {
    const h = placement.get(id)
    if (h) hostCounts.set(h, Math.max((hostCounts.get(h) ?? 1) - 1, 0))
    placement.delete(id)
  }
  const claim = (id: string, host: string | null): void => {
    if (host && !placement.has(id)) {
      placement.set(id, host)
      hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1)
    }
  }
  // Where to run an issue: null = local (no hosts configured); its existing pin if any; else the first host with a
  // free slot; else undefined = every worker is full, wait for one.
  const placeFor = (id: string): string | null | undefined => {
    if (hosts().length === 0) return null
    const pinned = placement.get(id)
    if (pinned && hosts().includes(pinned)) return pinned
    // Resume lands where the rollout lives: prefer the worker holding this ticket's thread (e.g. after a restart
    // dropped the in-memory pin), if it has a free slot; else fall back to spreading.
    const held = threadRecs.get(id)?.host
    if (held && hosts().includes(held) && (hostCounts.get(held) ?? 0) < getCfg().worker.maxPerHost) return held
    // Spread, don't pack: of the hosts with a free slot, take the least-loaded so VMs fill evenly.
    const free = hosts().filter((h) => (hostCounts.get(h) ?? 0) < getCfg().worker.maxPerHost)
    if (free.length === 0) return undefined
    return free.reduce((a, b) => ((hostCounts.get(a) ?? 0) <= (hostCounts.get(b) ?? 0) ? a : b))
  }
  const displayCap = (cap: number): number => (hosts().length === 0 ? cap : Math.min(cap, hosts().length * getCfg().worker.maxPerHost))

  return { placement, hostCounts, hosts, freePlacement, claim, placeFor, displayCap }
}
