import { ago, fmtTok, roleColor, stripHostSuffix } from '../lib/format'
import { prefetchLog } from '../lib/useLogStream'
import type { RoleItem } from '../lib/types'

function RoleCard({
  r,
  onOpen,
  onAction,
  busy,
}: {
  r: RoleItem
  onOpen: (name: string) => void
  onAction: (id: string, action: string) => void
  busy: boolean
}) {
  const live = r.status === 'running'
  const paused = r.paused
  const col = roleColor(r.name)
  const dc = paused ? 'var(--color-mut2)' : live ? 'var(--color-good)' : 'var(--color-mut2)'
  const cap = r.maxPerDay != null ? r.maxPerDay + (r.granted || 0) : null
  const capped = cap != null && r.filedToday >= cap
  const stat = paused ? 'paused' : live ? 'working' : capped ? 'capped today' : r.lastRunAt ? `last run ${ago(Date.now() - r.lastRunAt)} ago` : 'idle'

  return (
    <div
      class={`rcard${paused ? ' paused' : ''}`}
      data-role={r.name}
      style={{ borderLeftColor: col }}
      onClick={() => onOpen(r.name)}
      onMouseOver={() => prefetchLog(r.name)}
    >
      <div class="flex items-center gap-2">
        <span class="font-[650] text-[13.5px] capitalize tracking-[.2px]" style={{ color: col }}>
          {r.name}
        </span>
        {r.model && (
          <span class="text-[10px] text-mut2 font-[ui-monospace,Menlo,monospace] bg-surf2 border border-line rounded-[5px] py-[1.5px] px-1.5">
            {r.model}
          </span>
        )}
        <span class="ml-auto text-[11px] text-mut inline-flex items-center gap-[5px]">
          <i class="inline-block w-[7px] h-[7px] rounded-full" style={{ background: dc }} />
          {stat}
        </span>
        {!live && !paused && (
          <button
            class={`runbtn${busy ? ' busy' : ''}`}
            title={`run ${r.name} now (skip the cadence wait)`}
            onClick={(e) => {
              e.stopPropagation()
              onAction(r.name, 'run')
            }}
          >
            ▶ run
          </button>
        )}
        {paused ? (
          <button
            class={`runbtn${busy ? ' busy' : ''}`}
            title={`resume ${r.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onAction(r.name, 'pause')
            }}
          >
            ▶ resume
          </button>
        ) : (
          <button
            class={`ml-1.5 bg-[#1a1410] border border-[#4a3a1a] text-warn rounded-md py-px px-[7px] text-[11px] font-bold cursor-pointer hover:bg-[#221a10] hover:border-warn${busy ? ' busy' : ''}`}
            title={`pause ${r.name} (stop its cadence runs)`}
            onClick={(e) => {
              e.stopPropagation()
              onAction(r.name, 'pause')
            }}
          >
            ⏸
          </button>
        )}
      </div>
      <div class="text-mut text-xs mt-[9px] leading-[1.45] min-h-[17px] line-clamp-2">
        {paused ? (
          <span class="text-mut2">paused by operator &middot; no cadence runs until resumed</span>
        ) : live ? (
          (r.activity || 'working…').slice(0, 120)
        ) : (
          <span class="text-mut2">{capped ? 'daily cap reached · resumes at UTC midnight' : 'waiting for next run'}</span>
        )}
      </div>
      <div class="text-[11px] text-mut2 mt-[9px] tabular-nums">
        ↻ every {ago(r.cadenceMs)}
        {r.maxPerDay != null && (
          <>
            {' '}
            &middot;{' '}
            <span style={{ color: capped ? 'var(--color-warn)' : 'var(--color-mut2)' }}>
              {r.filedToday}/{cap} today{(r.granted || 0) > 0 ? ` (+${r.granted})` : ''}
            </span>{' '}
            <button
              class={`grantbtn${busy ? ' busy' : ''}`}
              title={`grant ${r.name} +${r.maxPerDay} tickets for today`}
              onClick={(e) => {
                e.stopPropagation()
                onAction(r.name, 'grant')
              }}
            >
              +{r.maxPerDay}
            </button>
          </>
        )}
        {r.tokens > 0 && (
          <>
            {' '}
            &middot; Σ {fmtTok(r.tokens)} tok
          </>
        )}
        {r.host && (
          <>
            {' '}
            &middot; {stripHostSuffix(r.host)}
          </>
        )}
      </div>
    </div>
  )
}

export function RoleDock({
  roles,
  onOpen,
  onAction,
  busyIds,
}: {
  roles: RoleItem[]
  onOpen: (name: string) => void
  onAction: (id: string, action: string) => void
  busyIds: Set<string>
}) {
  if (!roles.length) return <div id="dock" style={{ display: 'none' }} />
  return (
    <div
      id="dock"
      class="flex-none pt-3 px-[22px] pb-4 border-t border-line bg-[linear-gradient(180deg,rgba(11,12,17,.35),rgba(9,10,14,.85))]"
    >
      <div class="text-[11px] tracking-[.7px] uppercase text-mut font-bold mx-1 mb-[11px]">◆ the pool &middot; always-on</div>
      <div class="flex gap-[14px] flex-wrap">
        {roles.map((r) => (
          <RoleCard key={r.name} r={r} onOpen={onOpen} onAction={onAction} busy={busyIds.has(r.name)} />
        ))}
      </div>
    </div>
  )
}
