import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { DANGER_CONFIRM } from './actions'
import type { Snapshot } from './types'

export interface OptimisticOverride {
  state: string
  expiresAt: number
}

// Central action-dispatch logic ported from the old dashboard's `postAction`. Owns:
//  - the danger-confirm gate
//  - optimistic state overrides for move: actions, expiring after 5s or being superseded by a real snapshot
//    update showing the actual new state, and reverting on failure
//  - optimistic pause toggle (global + per-role), reverting on failure
//  - toast reporting, wired by the caller via onResult
//  - busy-button tracking is left to the caller (per-button local state), this hook returns { busy } per action id
export function useActions(
  snap: Snapshot,
  setSnap: (s: Snapshot) => void,
  onResult: (msg: string, isErr: boolean) => void,
  now: number,
): {
  effState: (identifier: string, actual: string) => string
  postAction: (id: string, action: string) => Promise<void>
  busyIds: Set<string>
} {
  const [overrides, setOverrides] = useState<Record<string, OptimisticOverride>>({})
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const snapRef = useRef(snap)
  snapRef.current = snap

  // Sweep expired/superseded overrides whenever the snapshot's items change, the 1s clock ticks, or an override
  // is added/removed. An override clears once the real item shows the target state, once it expires (5s), or if
  // the item vanished. Re-running right after this effect's own setOverrides call is harmless: the swept map has
  // nothing left to remove on that pass, so `changed` comes back false and the loop settles immediately.
  useEffect(() => {
    if (Object.keys(overrides).length === 0) return
    const byId = new Map(snap.items.map((i) => [i.identifier, i]))
    let changed = false
    const next: Record<string, OptimisticOverride> = {}
    for (const id in overrides) {
      const ov = overrides[id]!
      const it = byId.get(id)
      if (!it || it.state === ov.state || Date.now() > ov.expiresAt) {
        changed = true
        continue
      }
      next[id] = ov
    }
    if (changed) setOverrides(next)
  }, [snap.items, now, overrides])

  const effState = useCallback(
    (identifier: string, actual: string): string => {
      const o = overrides[identifier]
      return o ? o.state : actual
    },
    [overrides],
  )

  const postAction = useCallback(
    async (id: string, action: string): Promise<void> => {
      if (DANGER_CONFIRM[action] && !confirm(id + ': ' + DANGER_CONFIRM[action])) return
      setBusy((b) => new Set(b).add(id))

      let revert: (() => void) | null = null
      if (id === '__pause__' && action === 'toggle') {
        const was = snapRef.current.paused
        setSnap({ ...snapRef.current, paused: !snapRef.current.paused })
        revert = () => setSnap({ ...snapRef.current, paused: was })
      } else if (action === 'pause') {
        const role = (snapRef.current.roles || []).find((r) => r.name === id)
        if (role) {
          const wasPaused = !!role.paused
          setSnap({ ...snapRef.current, roles: snapRef.current.roles.map((r) => (r.name === id ? { ...r, paused: !r.paused } : r)) })
          revert = () => setSnap({ ...snapRef.current, roles: snapRef.current.roles.map((r) => (r.name === id ? { ...r, paused: wasPaused } : r)) })
        }
      } else if (action.indexOf('move:') === 0) {
        const to = action.slice(5)
        setOverrides((o) => ({ ...o, [id]: { state: to, expiresAt: Date.now() + 5000 } }))
        revert = () =>
          setOverrides((o) => {
            const next = { ...o }
            delete next[id]
            return next
          })
      }

      let ok = false
      try {
        const r = (await (
          await fetch('/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, action }) })
        ).json()) as { ok?: boolean; msg?: string }
        ok = !!(r && r.ok)
        const sys = (id || '').indexOf('__') === 0
        onResult(ok ? (sys ? '' : id + ' — ') + (r.msg || 'done') : 'Failed: ' + ((r && r.msg) || 'error'), !ok)
      } catch {
        onResult('Action failed', true)
      }
      if (!ok && revert) revert()
      setBusy((b) => {
        const next = new Set(b)
        next.delete(id)
        return next
      })
    },
    // postAction is returned to callers and invoked later from event handlers, so it needs a stable identity —
    // it can't depend on `snap` directly or every snapshot update would hand callers a new function. It reads
    // the latest snapshot through snapRef instead, which is intentional, not a workaround.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setSnap, onResult],
  )

  return { effState, postAction, busyIds: busy }
}
