import { ago, estCost, fmtCost, fmtTok } from '../lib/format'
import type { Snapshot } from '../lib/types'

function RateLimitChip({ rl }: { rl: Snapshot['rateLimits'] }) {
  if (!rl || rl.usedPercent == null) return null
  const pct = rl.usedPercent
  const col = pct >= 95 ? '#e0564f' : pct >= 80 ? '#d99a2b' : '#3fb27f'
  const bg = pct >= 95 ? '#e0564f22' : pct >= 80 ? '#d99a2b22' : ''
  const label = `${Math.round(pct)}% rl${rl.resetsInSeconds != null ? ` (${Math.round(rl.resetsInSeconds)}s)` : ''}`
  return (
    <span
      class="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surf px-2.5 py-1 text-xs shadow-[var(--sh1)]"
      title="rate-limit usage (Symphony §13.3)"
      style={bg ? { background: bg, borderColor: col + '44' } : undefined}
    >
      <i class="h-[7px] w-[7px] rounded-full" style={{ background: col }} />
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
  const items = snap.items || []
  const running = items.filter((r) => r.status === 'running').length
  const queued = items.filter((r) => r.status === 'queued').length
  const retrying = items.filter((r) => r.status === 'retrying').length
  const blocked = items.filter((r) => r.status === 'blocked').length
  const sr = snap.secondsRunning || 0
  const srH = Math.floor(sr / 3600)
  const srM = Math.floor((sr % 3600) / 60)
  const srS = Math.floor(sr % 60)
  const srStr = (srH ? srH + 'h ' : '') + (srH || srM ? srM + 'm' : srS + 's')

  return (
    <header class="sticky top-0 z-10 flex flex-none items-center gap-[14px] border-b border-line px-[22px] py-[14px]">
      <div class="flex items-center gap-2.5 text-sm font-[650] tracking-[.2px]">
        <span class="mark" />
        bunion
        <span class="ml-0.5 text-[12.5px] font-normal tracking-[.2px] text-mut" id="scope">
          {snap.scope || ''}
        </span>
      </div>
      <div class="ml-1.5 flex flex-wrap gap-[7px]" id="stats">
        <span class="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surf px-2.5 py-1 text-xs shadow-[var(--sh1)]">
          <i class="h-[7px] w-[7px] rounded-full bg-good" />
          {running} running
        </span>
        {queued > 0 && (
          <span class="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surf px-2.5 py-1 text-xs shadow-[var(--sh1)]">
            <i class="h-[7px] w-[7px] rounded-full bg-neutral" />
            {queued} queued
          </span>
        )}
        {retrying > 0 && (
          <span class="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surf px-2.5 py-1 text-xs shadow-[var(--sh1)]">
            <i class="h-[7px] w-[7px] rounded-full bg-warn" />
            {retrying} retrying
          </span>
        )}
        {blocked > 0 && (
          <span class="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surf px-2.5 py-1 text-xs shadow-[var(--sh1)]" title="waiting on another ticket to finish — not a capacity issue">
            <i class="h-[7px] w-[7px] rounded-full bg-warn" />
            {blocked} blocked
          </span>
        )}
        <span class="self-center text-xs text-mut">{snap.cap || 0} slots</span>
        {snap.totalTokens > 0 && (
          <span
            class="self-center text-xs text-mut"
            title="What this volume would cost at GPT-5.5 API rates. Actual spend is flat (the exe.dev plan + a ChatGPT subscription), not per-token — value extracted, not a bill."
          >
            Σ {fmtTok(snap.totalTokens)} tok
            {snap.totalInput > 0 && (
              <>
                {' '}
                &middot; <b class="text-good">{Math.round((snap.totalCached / snap.totalInput) * 100)}% cached</b>
              </>
            )}{' '}
            &middot; ~{fmtCost(estCost(snap.totalInput, snap.totalOutput, snap.totalCached))} at API rates
          </span>
        )}
        {sr > 0 && (
          <span class="self-center text-xs text-mut" title="aggregate runtime across all sessions (Symphony §13.3 secondsRunning)">
            ⏱ {srStr}
          </span>
        )}
        {snap.gatewayAccounts && snap.gatewayAccounts.length > 0 && (
          <span
            class="self-center text-xs text-mut"
            title="ChatGPT account each worker routes gpt-5.5 through (resolved live from each worker config); your ChatGPT subscriptions via the exe.dev gateway, not the OpenAI API"
          >
            🔑 via {snap.gatewayAccounts.join(', ')}
          </span>
        )}
        <RateLimitChip rl={snap.rateLimits} />
      </div>
      <input
        id="search"
        class="ml-1.5 w-[170px] rounded-lg border border-line bg-surf px-[11px] py-1.5 font-['-apple-system',BlinkMacSystemFont,'Segoe_UI',sans-serif] text-[12.5px] leading-none text-fg outline-none transition-[width,border-color] duration-150 placeholder:text-mut2 focus:w-[230px] focus:border-accent"
        type="search"
        placeholder="filter tickets…"
        value={filterQuery}
        onInput={(e) => onFilter((e.target as HTMLInputElement).value)}
        aria-label="Filter tickets by id, title, host, or state"
      />
      <span class="ml-auto font-mono text-xs text-mut2 [font-variant-numeric:tabular-nums]" id="clock" data-clock>
        {new Date().toLocaleTimeString()}
      </span>
      <a
        href="/stats"
        target="_blank"
        rel="noopener"
        title="rollups + thread stats"
        class="ml-3 whitespace-nowrap rounded-lg border border-line bg-surf px-[11px] py-1.5 text-xs text-mut no-underline hover:border-line3 hover:text-fg"
      >
        📊 stats
      </a>
      <button
        id="pausebtn"
        class={`ml-3 cursor-pointer whitespace-nowrap rounded-lg border px-[13px] py-1.5 text-xs font-bold tracking-[.2px] transition-[background,border-color] duration-150 motion-safe:active:scale-[0.98] ${
          snap.paused
            ? 'border-good bg-[#11201a] text-good hover:bg-[#142a20]'
            : 'border-[#4a3a1a] bg-surf text-warn hover:border-warn hover:bg-[#1d1810]'
        }${pauseBusy ? ' busy' : ''}`}
        onClick={onPause}
      >
        {snap.paused ? '▶ Resume' : '⏸ Pause'}
      </button>
    </header>
  )
}

export function PauseBanner({ snap }: { snap: Snapshot }) {
  const ph = snap.pollHealth
  if (snap.paused) {
    return (
      <div
        id="pausebanner"
        class="show flex flex-none items-center gap-2.5 border-b border-[#5a2222] bg-[linear-gradient(90deg,#2a1414,#1a0f0f)] px-[22px] py-[9px] text-[12.5px] font-semibold text-[#e8a0a0]"
        role="status"
        aria-live="polite"
      >
        <span class="h-2 w-2 rounded-full bg-danger shadow-[0_0_8px_var(--color-danger)]" />
        <b>FACTORY PAUSED</b> &middot; dispatch halted, agents stopped &mdash; click Resume to continue
      </div>
    )
  }
  if (ph && ph.failureStreak >= 3) {
    return (
      <div
        id="pausebanner"
        class="show flex flex-none items-center gap-2.5 border-b border-[#5a2222] bg-[linear-gradient(90deg,#2a1414,#1a0f0f)] px-[22px] py-[9px] text-[12.5px] font-semibold text-[#e8a0a0]"
        role="status"
        aria-live="polite"
      >
        <span class="h-2 w-2 rounded-full bg-danger shadow-[0_0_8px_var(--color-danger)]" />
        <b>LINEAR POLLING FAILING</b> &middot; {ph.failureStreak} consecutive failures
        {ph.lastError ? ` — ${ph.lastError.slice(0, 140)}` : ''}
        {ph.lastOkAt ? ` · board last updated ${ago(Date.now() - ph.lastOkAt)} ago, may be stale` : ''}.
      </div>
    )
  }
  return <div id="pausebanner" role="status" aria-live="polite" />
}
