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
): {
  effState: (identifier: string, actual: string) => string
  postAction: (id: string, action: string) => Promise<void>
  busyIds: Set<string>
} {
  const [overrides, setOverrides] = useState<Record<string, OptimisticOverride>>({})
  const [busy, setBusy] = useState<Set<string>>(new Set())
  // postAction's revert closures run after an `await` -- if a real snapshot update arrives from the server
  // while that fetch is in flight, a revert built on `snap` captured at click-time would clobber it, because
  // setSnap takes a full Snapshot value rather than a (prev => next) updater. The ref always holds whatever
  // snapshot is current by the time revert() actually runs.
  const snapRef = useRef(snap)
  snapRef.current = snap

  // Clear an optimistic override the moment the real snapshot catches up — the item reached the target state or
  // vanished — or once it has expired (5s). This MUST mutate the map, not just be checked at read time: a
  // confirmed-but-not-removed override would re-activate and snap the card back to the old target if the ticket
  // moved again before its expiry. Keyed on snapshot changes only (SSE-frequency, NOT a per-second clock), so it
  // costs nothing between real updates. Functional setOverrides + no `overrides` dep avoids a self-trigger loop.
  useEffect(() => {
    setOverrides((cur) => {
      if (Object.keys(cur).length === 0) return cur
      const byId = new Map(snap.items.map((i) => [i.identifier, i]))
      const now = Date.now()
      let changed = false
      const next: Record<string, OptimisticOverride> = {}
      for (const id in cur) {
        const ov = cur[id]!
        const it = byId.get(id)
        if (!it || it.state === ov.state || now > ov.expiresAt) {
          changed = true
          continue
        }
        next[id] = ov
      }
      return changed ? next : cur
    })
  }, [snap.items])

  // Read-time guard on top of the sweep: hides an expired override even if no snapshot has arrived to sweep it.
  const effState = useCallback(
    (identifier: string, actual: string): string => {
      const o = overrides[identifier]
      return o && Date.now() < o.expiresAt && actual !== o.state ? o.state : actual
    },
    [overrides],
  )

  // Not memoized: every caller (DashboardApp's handleAction and friends) already wraps this in its own
  // non-memoized closure before passing it further down, so a stable identity here was never consumed by
  // anything -- a useCallback here bought nothing and only invited the ref-mirroring workaround below to look
  // load-bearing when it wasn't the reason snapRef exists (see snapRef's own comment for the real reason).
  const postAction = async (id: string, action: string): Promise<void> => {
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
      // Optimistically show the target state; the snapshot-keyed sweep above clears it once the move confirms,
      // the item vanishes, or it expires (5s).
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
  }

  return { effState, postAction, busyIds: busy }
}
