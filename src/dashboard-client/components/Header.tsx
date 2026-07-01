import { useEffect, useState } from 'preact/hooks'
import { ago, estCost, fmtCost, fmtTok } from '../lib/format'
import type { Snapshot } from '../lib/types'

function RateLimitChip({ rl }: { rl: Snapshot['rateLimits'] }) {
  if (!rl || rl.usedPercent == null) return null
  const pct = rl.usedPercent
  const col = pct >= 95 ? '#e0564f' : pct >= 80 ? '#d99a2b' : '#3fb27f'
  const bg = pct >= 95 ? '#e0564f22' : pct >= 80 ? '#d99a2b22' : ''
  const label = `${Math.round(pct)}% rl${rl.resetsInSeconds != null ? ` (${Math.round(rl.resetsInSeconds)}s)` : ''}`
  return (
    <span class="chip" title="rate-limit usage (Symphony §13.3)" style={bg ? { background: bg, borderColor: col + '44' } : undefined}>
      <i style={{ background: col }} />
      <span style={{ color: col }}>{label}</span>
    </span>
  )
}

export function Header({
  snap,
  filterQuery,
  onFilter,
  onPause,
  pauseBusy,
}: {
  snap: Snapshot
  filterQuery: string
  onFilter: (v: string) => void
  onPause: () => void
  pauseBusy: boolean
}) {
  const [clock, setClock] = useState(() => new Date().toLocaleTimeString())
  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toLocaleTimeString()), 1000)
    return () => clearInterval(t)
  }, [])

  const items = snap.items || []
  const running = items.filter((r) => r.status === 'running').length
  const queued = items.filter((r) => r.status === 'queued').length
  const retrying = items.filter((r) => r.status === 'retrying').length
  const sr = snap.secondsRunning || 0
  const srH = Math.floor(sr / 3600)
  const srM = Math.floor((sr % 3600) / 60)
  const srS = Math.floor(sr % 60)
  const srStr = (srH ? srH + 'h ' : '') + (srH || srM ? srM + 'm' : srS + 's')

  return (
    <header>
      <div class="brand">
        <span class="mark" />
        bunion
        <span class="sub" id="scope">
          {snap.scope || ''}
        </span>
      </div>
      <div class="stats" id="stats">
        <span class="chip">
          <i style={{ background: '#3fb27f' }} />
          {running} running
        </span>
        {queued > 0 && (
          <span class="chip">
            <i style={{ background: '#7c8493' }} />
            {queued} queued
          </span>
        )}
        {retrying > 0 && (
          <span class="chip">
            <i style={{ background: '#d99a2b' }} />
            {retrying} retrying
          </span>
        )}
        <span class="cap">{snap.cap || 0} slots</span>
        {snap.totalTokens > 0 && (
          <span class="cap" title="What this volume would cost at GPT-5.5 API rates. Actual spend is flat (the exe.dev plan + a ChatGPT subscription), not per-token — value extracted, not a bill.">
            Σ {fmtTok(snap.totalTokens)} tok
            {snap.totalInput > 0 && (
              <>
                {' '}
                &middot; <b style={{ color: '#3fb27f' }}>{Math.round((snap.totalCached / snap.totalInput) * 100)}% cached</b>
              </>
            )}{' '}
            &middot; ~{fmtCost(estCost(snap.totalInput, snap.totalOutput, snap.totalCached))} at API rates
          </span>
        )}
        {sr > 0 && (
          <span class="cap" title="aggregate runtime across all sessions (Symphony §13.3 secondsRunning)">
            ⏱ {srStr}
          </span>
        )}
        {snap.gatewayAccounts && snap.gatewayAccounts.length > 0 && (
          <span class="cap" title="ChatGPT account each worker routes gpt-5.5 through (resolved live from each worker config); your ChatGPT subscriptions via the exe.dev gateway, not the OpenAI API">
            🔑 via {snap.gatewayAccounts.join(', ')}
          </span>
        )}
        <RateLimitChip rl={snap.rateLimits} />
      </div>
      <input
        id="search"
        class="search"
        type="search"
        placeholder="filter tickets…"
        value={filterQuery}
        onInput={(e) => onFilter((e.target as HTMLInputElement).value)}
        aria-label="Filter tickets by id, title, host, or state"
      />
      <span class="clock" id="clock">
        {clock}
      </span>
      <a href="/stats" target="_blank" rel="noopener" title="rollups + thread stats" class="statslink">
        📊 stats
      </a>
      <button id="pausebtn" class={`pausebtn${snap.paused ? ' on' : ''}${pauseBusy ? ' busy' : ''}`} onClick={onPause}>
        {snap.paused ? '▶ Resume' : '⏸ Pause'}
      </button>
    </header>
  )
}

export function PauseBanner({ snap }: { snap: Snapshot }) {
  const ph = snap.pollHealth
  if (snap.paused) {
    return (
      <div id="pausebanner" class="show" role="status" aria-live="polite">
        <span class="pb-dot" />
        <b>FACTORY PAUSED</b> &middot; dispatch halted, agents stopped &mdash; click Resume to continue
      </div>
    )
  }
  if (ph && ph.failureStreak >= 3) {
    return (
      <div id="pausebanner" class="show" role="status" aria-live="polite">
        <span class="pb-dot" />
        <b>LINEAR POLLING FAILING</b> &middot; {ph.failureStreak} consecutive failures
        {ph.lastError ? ` — ${ph.lastError.slice(0, 140)}` : ''}
        {ph.lastOkAt ? ` · board last updated ${ago(Date.now() - ph.lastOkAt)} ago, may be stale` : ''}.
      </div>
    )
  }
  return <div id="pausebanner" role="status" aria-live="polite" />
}
