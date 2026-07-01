import { ago, fmtTok, stripHostSuffix } from '../lib/format'
import { prefetchLog } from '../lib/useLogStream'
import type { RoleItem } from '../lib/types'

function roleColor(n: string): string {
  const name = (n || '').toLowerCase()
  return name === 'mechanic' ? '#d99a2b' : name === 'dreamer' ? '#b88cd9' : name === 'user-advocate' ? '#3fb29e' : '#5b8def'
}

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
  const dc = paused ? '#5a6270' : live ? '#3fb27f' : 'var(--mut2)'
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
      <div class="rtop">
        <span class="rname" style={{ color: col }}>
          {r.name}
        </span>
        {r.model && <span class="rmodel">{r.model}</span>}
        <span class="rstat">
          <i class="dot" style={{ background: dc }} />
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
            class={`pausebtn-r${busy ? ' busy' : ''}`}
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
      <div class="ract">
        {paused ? (
          <span style={{ color: 'var(--mut2)' }}>paused by operator &middot; no cadence runs until resumed</span>
        ) : live ? (
          (r.activity || 'working…').slice(0, 120)
        ) : (
          <span style={{ color: 'var(--mut2)' }}>{capped ? 'daily cap reached · resumes at UTC midnight' : 'waiting for next run'}</span>
        )}
      </div>
      <div class="rfoot">
        ↻ every {ago(r.cadenceMs)}
        {r.maxPerDay != null && (
          <>
            {' '}
            &middot;{' '}
            <span style={{ color: capped ? '#d99a2b' : 'var(--mut2)' }}>
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
    <div id="dock">
      <div class="docklab">◆ the pool &middot; always-on</div>
      <div class="dockrow">
        {roles.map((r) => (
          <RoleCard key={r.name} r={r} onOpen={onOpen} onAction={onAction} busy={busyIds.has(r.name)} />
        ))}
      </div>
    </div>
  )
}
