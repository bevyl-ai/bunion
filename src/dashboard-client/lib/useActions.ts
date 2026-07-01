import { useCallback, useRef, useState } from 'preact/hooks'
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
  // postAction's revert closures run after an `await` -- if a real snapshot update arrives from the server
  // while that fetch is in flight, a revert built on `snap` captured at click-time would clobber it, because
  // setSnap takes a full Snapshot value rather than a (prev => next) updater. The ref always holds whatever
  // snapshot is current by the time revert() actually runs.
  const snapRef = useRef(snap)
  snapRef.current = snap

  // An override is "live" only until the real state catches up (actual === target), it expires (5s), or the item
  // vanishes. Rather than a state-syncing effect that sweeps the map on every snapshot/clock change, decide
  // liveness at read time in effState — the 1s `now` tick already re-renders, so an expired override reverts on
  // the next tick. Stale keys are pruned opportunistically when a new move override is added (see postAction).
  const effState = useCallback(
    (identifier: string, actual: string): string => {
      const o = overrides[identifier]
      return o && now < o.expiresAt && actual !== o.state ? o.state : actual
    },
    [overrides, now],
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
      const at = Date.now()
      // Drop any already-expired overrides while we add this one, so the map can't accumulate stale keys.
      setOverrides((o) => {
        const next: Record<string, OptimisticOverride> = {}
        for (const k in o) if (at < o[k]!.expiresAt) next[k] = o[k]!
        next[id] = { state: to, expiresAt: at + 5000 }
        return next
      })
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
