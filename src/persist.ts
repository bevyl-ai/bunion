import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// bunion's small state files under ~/.bunion (tokens, logs, threads). None are critical — they let numbers and
// transcripts survive a daemon restart — so reads degrade to a default and writes are best-effort.

// Read a JSON object from disk, or `fallback` if it's missing, unreadable, or not an object.
export function readJson<T>(path: string, fallback: T): T {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return v && typeof v === 'object' ? (v as T) : fallback
  } catch {
    return fallback
  }
}

// Write JSON to disk, creating the parent dir. Failures are swallowed — persistence is non-critical.
export function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(value))
  } catch {
    // best effort
  }
}

// BEV re-audit: a throttled write debounced up to `ms` (default 3s) was never forced out on a clean shutdown — a
// daemon restart inside that window silently lost the most recent write (e.g. a thread's lastTokenBase, dropping
// it back to the safe-but-imprecise zero-reseed path on its next resume). Every throttledWriter registers its
// flush here so a shutdown handler can force them all out synchronously before the process exits.
const pending: (() => void)[] = []
export function flushAllPending(): void {
  for (const flush of pending) flush()
}

// A coalescing writer for a hot-path state file: writes at most once per `ms` — immediately when idle, then once
// more on the trailing edge so the latest value always lands. `get` is read at write time, so callers just mutate
// their state and call the returned function; there are no stale snapshots and no per-file debounce bookkeeping.
export function throttledWriter(path: string, get: () => unknown, ms = 3000): () => void {
  let lastWrite = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) { clearTimeout(timer); timer = null }
    lastWrite = Date.now()
    writeJson(path, get())
  }
  pending.push(flush)
  return () => {
    if (timer) return
    const wait = lastWrite + ms - Date.now()
    if (wait <= 0) flush()
    else timer = setTimeout(flush, wait)
  }
}
