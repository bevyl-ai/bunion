import { ago, staleColor } from './format'

// One vanilla per-second ticker that patches live time displays directly in the DOM — no React state, no
// full-tree re-render. Components render the initial value (from Date.now()) plus a data- attribute holding the
// base timestamp; this rewrites only the text/colour each second. Started once from the client entry.
//
//   [data-clock]      → wall clock, HH:MM:SS
//   [data-since=<ts>] → textContent = ago(now - ts)     (elapsed since ts)
//   [data-until=<ts>] → textContent = ago(ts - now)     (countdown to ts)
//   [data-dot=<ts>]   → background = staleColor(now - ts) (activity-freshness dot)
let started = false
export function startLiveClock(): void {
  if (started || typeof document === 'undefined') return
  started = true
  const tick = (): void => {
    const now = Date.now()
    document.querySelectorAll<HTMLElement>('[data-clock]').forEach((el) => (el.textContent = new Date().toLocaleTimeString()))
    document.querySelectorAll<HTMLElement>('[data-since]').forEach((el) => (el.textContent = ago(now - Number(el.dataset.since))))
    document.querySelectorAll<HTMLElement>('[data-until]').forEach((el) => (el.textContent = ago(Number(el.dataset.until) - now)))
    document.querySelectorAll<HTMLElement>('[data-dot]').forEach((el) => (el.style.background = staleColor(now - Number(el.dataset.dot))))
  }
  tick()
  setInterval(tick, 1000)
}
