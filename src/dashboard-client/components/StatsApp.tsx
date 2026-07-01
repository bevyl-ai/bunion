import { useEffect, useMemo, useState } from 'preact/hooks'
import { dur, fmtTokStats, oc } from '../lib/statsFormat'
import type { SortKey, StatsData } from '../lib/statsTypes'

const HEADERS: { k: SortKey; label: string }[] = [
  { k: 'tokens', label: 'tokens' },
  { k: 'cycle_ms', label: 'cycle' },
  { k: 'reworks', label: 'reworks' },
  { k: 'caps', label: 'cap/dl' },
]

const num = (v: unknown): number => (typeof v === 'number' ? v : 0)

export function StatsApp() {
  const [data, setData] = useState<StatsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('tokens')
  const [dir, setDir] = useState<-1 | 1>(-1)

  useEffect(() => {
    fetch('/stats.json', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: StatsData) => setData(d))
      .catch((e) => setError(String(e)))
  }, [])

  const onSort = (k: SortKey): void => {
    if (sortKey === k) setDir((d) => (d === -1 ? 1 : -1))
    else {
      setSortKey(k)
      setDir(-1)
    }
  }

  const threads = useMemo(() => {
    if (!data) return []
    return data.threads.slice().sort((a, b) => (num(a[sortKey]) - num(b[sortKey])) * dir)
  }, [data, sortKey, dir])

  const totals = data?.totals
  const daily = data?.daily || []
  const maxDailyTokens = Math.max(1, ...daily.map((d) => num(d.tokens)))

  const totalCards: { label: string; value: number | undefined }[] = [
    { label: 'tickets', value: totals?.tickets },
    { label: 'events', value: totals?.events },
    { label: 'deadlocks', value: totals?.deadlocks },
    { label: 'caps', value: totals?.caps },
  ]

  return (
    <>
      <h1>
        <span class="mark" />
        bunion <span class="text-mut2">&middot; stats</span>
        <a class="ml-auto text-[12.5px] font-normal text-mut" href="/">
          ← board
        </a>
      </h1>
      <div class="mt-[18px] mb-[6px] flex flex-wrap gap-[11px]" id="tot">
        {totalCards.map(({ label, value }) => (
          <div
            class="rounded-[10px] border border-line bg-surf px-4 py-[9px] tabular-nums shadow-[0_1px_2px_rgba(0,0,0,.4)]"
            key={label}
          >
            <b class="block text-[19px] font-[650] text-fg">{value || 0}</b>
            <span class="text-[10px] tracking-[.6px] text-mut uppercase">{label}</span>
          </div>
        ))}
      </div>
      <h2>last 30 days</h2>
      <div class="overflow-hidden rounded-xl border border-line bg-surf shadow-[0_1px_2px_rgba(0,0,0,.4)]">
        <table id="daily">
          <thead>
            <tr>
              <th>day</th>
              <th>dispatched</th>
              <th>shipped</th>
              <th>tokens</th>
              <th>deadlocks</th>
              <th>caps</th>
            </tr>
          </thead>
          <tbody>
            {daily.length ? (
              daily.map((r) => (
                <tr key={r.day}>
                  <td>{r.day}</td>
                  <td>{r.dispatched || 0}</td>
                  <td class="text-green">{r.shipped || 0}</td>
                  <td>
                    {fmtTokStats(r.tokens)}
                    <span
                      class="ml-[7px] inline-block h-[7px] rounded bg-accent align-middle opacity-60"
                      style={{ width: Math.round((num(r.tokens) / maxDailyTokens) * 70) + 'px' }}
                    />
                  </td>
                  <td style={r.deadlocks ? { color: 'var(--color-amber)' } : undefined}>{r.deadlocks || 0}</td>
                  <td style={r.caps ? { color: 'var(--color-red)' } : undefined}>{r.caps || 0}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} class="p-[22px] text-center text-mut2">
                  no activity recorded yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <h2>
        threads{' '}
        <span class="font-normal tracking-normal text-mut2 normal-case">— click a column to rank best/worst</span>
      </h2>
      <div class="overflow-hidden rounded-xl border border-line bg-surf shadow-[0_1px_2px_rgba(0,0,0,.4)]">
        <table id="th">
          <thead>
            <tr>
              <th>ticket</th>
              <th>outcome</th>
              {HEADERS.map((h) => (
                <th
                  key={h.k}
                  class={`cursor-pointer select-none hover:text-fg${sortKey === h.k ? ' act' : ''}`}
                  onClick={() => onSort(h.k)}
                >
                  {h.label}
                </th>
              ))}
              <th>account</th>
              <th>thread</th>
            </tr>
          </thead>
          <tbody>
            {threads.length ? (
              threads.map((r) => (
                <tr key={r.identifier}>
                  <td>
                    <a
                      class="[font-family:ui-monospace,Menlo,monospace] font-semibold"
                      href={`https://linear.app/bevyl/issue/${r.identifier}`}
                      target="_blank"
                      rel="noopener"
                    >
                      {r.identifier}
                    </a>
                  </td>
                  <td>
                    <span
                      class="rounded-[20px] px-[9px] py-0.5 text-[10.5px] font-semibold"
                      style={{ background: oc(r.outcome) + '22', color: oc(r.outcome) }}
                    >
                      {r.outcome || '—'}
                    </span>
                  </td>
                  <td>{fmtTokStats(r.tokens)}</td>
                  <td>{dur(r.cycle_ms)}</td>
                  <td>{r.reworks || 0}</td>
                  <td>{(r.caps || 0) + (r.deadlocks || 0) || ''}</td>
                  <td class="text-[11px] text-mut">{(r.account || '').replace(/ .*/, '') || '—'}</td>
                  <td class="[font-family:ui-monospace,Menlo,monospace] text-[11px] text-mut2">{(r.thread_id || '').slice(0, 12) || '—'}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8} class="p-[22px] text-center text-mut2">
                  no threads recorded yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {error && <p class="text-red">failed to load stats: {error}</p>}
    </>
  )
}
