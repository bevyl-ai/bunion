import { useEffect, useRef, useState } from 'preact/hooks'

// Cache is module-level (not per-hook-instance) so hover-prefetch and the modal itself share one store.
const logCache = new Map<string, string[]>()

export function prefetchLog(id: string | null | undefined): void {
  if (!id || logCache.has(id)) return
  fetch('/transcript/' + encodeURIComponent(id), { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { log?: string[] } | null) => {
      if (j && j.log) logCache.set(id, j.log)
    })
    .catch(() => {
      /* best-effort */
    })
}

export function getCachedLog(id: string): string[] | undefined {
  return logCache.get(id)
}

export interface LogStreamState {
  lines: string[]
  live: string // in-progress streaming agent reply, '' when none
  loaded: boolean // false while showing the skeleton (no cached/seeded data yet)
}

// Drives the ticket-detail modal's transcript body. Owns:
//  - SSE via /log-stream/<id>, seeded from the module-level cache if hover-prefetch already warmed it
//  - graceful degradation to 1s polling of /transcript/<id> if EventSource is unavailable or errors
//  - seed (full replace) vs append vs shrunk-seed (restart-from-scratch => full replace) semantics
//  - the live partial-reply block, replaced in place as it grows, removed on commit or explicit empty live
export function useLogStream(id: string | null): LogStreamState {
  const [lines, setLines] = useState<string[]>(() => (id ? logCache.get(id) ?? [] : []))
  const [live, setLive] = useState('')
  const [loaded, setLoaded] = useState<boolean>(() => !!(id && logCache.has(id)))

  // The modal is never unmounted between tickets/roles, so a changed `id` doesn't reset this hook's state on
  // its own -- without this, closing one ticket's transcript and opening another briefly paints the old one
  // under the new header until the effect below runs (which happens after paint). Reset synchronously during
  // render instead, so a stale transcript never has a frame to appear in.
  const lastId = useRef(id)
  if (lastId.current !== id) {
    lastId.current = id
    setLines(id ? logCache.get(id) ?? [] : [])
    setLive('')
    setLoaded(!!(id && logCache.has(id)))
  }

  useEffect(() => {
    if (!id) return
    let cancelled = false
    let es: EventSource | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    // The subscription below can still be open -- and still deliver a queued network frame -- for a moment
    // after render has already moved on to a different id: the render-phase reset above updates lastId.current
    // synchronously, but this effect's own cleanup (which tears the subscription down) only runs later, after
    // paint. Every callback checks lastId.current, not just `cancelled`, so a late frame from an id nobody is
    // looking at anymore can never overwrite state for whatever id is current by the time it arrives.
    const stale = (): boolean => cancelled || lastId.current !== id

    const cached = logCache.get(id)
    setLines(cached ?? [])
    setLive('')
    setLoaded(!!cached)

    const pullOnce = async (): Promise<void> => {
      try {
        const res = await fetch('/transcript/' + encodeURIComponent(id), { cache: 'no-store' })
        if (!res.ok || (res.headers.get('content-type') || '').indexOf('json') < 0) return
        const j = (await res.json()) as { log?: string[] }
        if (stale()) return
        const ls = j.log || []
        logCache.set(id, ls)
        setLines(ls)
        setLoaded(true)
      } catch {
        /* best-effort; next tick retries */
      }
    }

    const startPolling = (): void => {
      if (poll) return
      poll = setInterval(pullOnce, 1000)
      pullOnce()
    }

    if (typeof EventSource === 'undefined') {
      startPolling()
    } else {
      try {
        es = new EventSource('/log-stream/' + encodeURIComponent(id))
      } catch {
        startPolling()
      }
      if (es) {
        es.onmessage = (e) => {
          if (stale()) return
          let j: { seed?: boolean; lines?: string[]; live?: string }
          try {
            j = JSON.parse(e.data)
          } catch {
            return
          }
          if (j.seed) {
            const ls = j.lines || []
            logCache.set(id, ls)
            setLines(ls)
            setLoaded(true)
            setLive('')
          } else if (j.lines && j.lines.length) {
            const newLines = j.lines
            setLines((prev) => {
              const next = prev.concat(newLines)
              logCache.set(id, next)
              return next
            })
            setLive('')
          } else if ('live' in j) {
            setLive(j.live || '')
          }
        }
        es.onerror = () => {
          try {
            es?.close()
          } catch {
            /* ignore */
          }
          es = null
          if (!stale()) startPolling()
        }
      }
    }

    return () => {
      cancelled = true
      if (es) {
        try {
          es.close()
        } catch {
          /* ignore */
        }
      }
      if (poll) clearInterval(poll)
    }
  }, [id])

  return { lines, live, loaded }
}
