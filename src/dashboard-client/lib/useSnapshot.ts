import { useEffect, useState } from 'preact/hooks'
import { DEFAULT_COLUMNS, type BoardColumn, type Snapshot } from './types'

const EMPTY_SNAPSHOT: Snapshot = {
  scope: '',
  cap: 0,
  items: [],
  totalTokens: 0,
  totalInput: 0,
  totalOutput: 0,
  totalCached: 0,
  paused: false,
  rateLimits: null,
  secondsRunning: 0,
  roles: [],
  columns: [],
  gatewayAccounts: [],
}

// SSE + polling-fallback lifecycle for the board snapshot:
//  - fetch /state.json once immediately for a fast first paint
//  - then open an EventSource to /events for live push updates
//  - if EventSource is unavailable at all, fall back to polling /state.json every 1s
//  - if the SSE connection errors mid-session: close it, start 1s polling immediately, and after 5s try
//    reopening SSE — if that succeeds, stop the polling fallback and resume pure SSE. Repeats indefinitely.
export function useSnapshot(): { snap: Snapshot; cols: BoardColumn[]; setSnap: (s: Snapshot) => void } {
  const [snap, setSnapState] = useState<Snapshot>(EMPTY_SNAPSHOT)
  const [cols, setCols] = useState<BoardColumn[]>(DEFAULT_COLUMNS)

  const applySnap = (s: Snapshot): void => {
    setSnapState(s)
    if (s.columns && s.columns.length) setCols(s.columns)
  }

  useEffect(() => {
    let es: EventSource | null = null
    let pollFallback: ReturnType<typeof setInterval> | null = null
    let reopenTimer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    const pull = async (): Promise<void> => {
      try {
        const res = await fetch('/state.json', { cache: 'no-store' })
        const j = (await res.json()) as Snapshot
        if (!cancelled) applySnap(j)
      } catch {
        /* best-effort; next tick retries */
      }
    }

    const startSSE = (): void => {
      if (typeof EventSource === 'undefined') {
        if (!pollFallback) pollFallback = setInterval(pull, 1000)
        return
      }
      try {
        es = new EventSource('/events')
      } catch {
        if (!pollFallback) pollFallback = setInterval(pull, 1000)
        return
      }
      es.onmessage = (e) => {
        try {
          const j = JSON.parse(e.data) as Snapshot
          if (!cancelled) applySnap(j)
        } catch {
          /* ignore malformed frame */
        }
      }
      es.onerror = () => {
        try {
          es?.close()
        } catch {
          /* ignore */
        }
        es = null
        if (!pollFallback) pollFallback = setInterval(pull, 1000)
        reopenTimer = setTimeout(() => {
          if (pollFallback) {
            clearInterval(pollFallback)
            pollFallback = null
          }
          startSSE()
        }, 5000)
      }
    }

    pull().then(() => {
      if (!cancelled) startSSE()
    })

    return () => {
      cancelled = true
      if (es) {
        try {
          es.close()
        } catch {
          /* ignore */
        }
      }
      if (pollFallback) clearInterval(pollFallback)
      if (reopenTimer) clearTimeout(reopenTimer)
    }
  }, [])

  return { snap, cols, setSnap: applySnap }
}
