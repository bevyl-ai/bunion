import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { actionList } from '../lib/actions'
import { ago, estCost, fmtCost, fmtTok, PRI, prNumFromUrl, roleColor, SC, stripHostSuffix } from '../lib/format'
import { useLogStream } from '../lib/useLogStream'
import type { BoardItem, RoleItem } from '../lib/types'
import { ChatBox } from './ChatBox'
import { Transcript } from './Transcript'

export function Modal({
  expandedId,
  item,
  role,
  onClose,
  onAction,
  onMoveMenu,
  onChat,
  chatPending,
  busy,
}: {
  expandedId: string | null
  item: BoardItem | null // resolved ticket (with any optimistic override already applied by the caller)
  role: RoleItem | null
  onClose: () => void
  onAction: (id: string, action: string) => void
  onMoveMenu: (id: string, ev: MouseEvent) => void
  onChat: (id: string, text: string) => Promise<void>
  chatPending: boolean
  busy: boolean // true while an action for the expanded ticket is in flight — dims the mactions buttons
}) {
  const { lines, live, loaded } = useLogStream(expandedId)
  const logRef = useRef<HTMLDivElement | null>(null)

  const open = !!expandedId

  // ArrowUp/ArrowDown scroll the transcript while the modal is open; Escape closes from anywhere.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const lb = logRef.current
        if (lb) lb.scrollTop += e.key === 'ArrowDown' ? 140 : -140
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return <div id="modal" />

  const isRole = !!role

  return (
    <div id="modal" class="open" style={{ display: 'flex' }} onClick={(e) => { if ((e.target as HTMLElement).id === 'modal') onClose() }}>
      <div id="mpanel" role="dialog" aria-modal="true" aria-labelledby="mtitle" class="bg-surf border border-line2 rounded-2xl w-[min(960px,100%)] max-h-[86vh] flex flex-col overflow-hidden">
        <ModalHead item={item} role={role} onClose={onClose} />
        <ModalSub item={item} role={role} />
        <ModalBanner item={item} isRole={isRole} />
        <ModalTokens item={item} isRole={isRole} />
        <Transcript logRef={logRef} lines={lines} live={live} loaded={loaded} chatPending={chatPending} />
        <ChatBox
          placeholder={isRole && role ? `Prompt ${role.name} — steers next run` : 'Message the agent — steer it (state, plan)'}
          pending={chatPending}
          onSend={(text) => onChat(expandedId!, text)}
        />
        <ModalActions item={item} isRole={isRole} onAction={onAction} onMoveMenu={onMoveMenu} busy={busy} />
      </div>
    </div>
  )
}

function ModalHead({ item, role, onClose }: { item: BoardItem | null; role: RoleItem | null; onClose: () => void }) {
  const prNum = prNumFromUrl(item?.prUrl)
  return (
    <div id="mhead" class="flex items-center gap-2.5 px-[18px] py-3.5 border-b border-line flex-wrap bg-gradient-to-b from-[#191c24] to-surf">
      <span class="live" />
      <span id="mtitle" class="flex items-center gap-2.5 font-mono font-semibold text-sm">
        {role ? (
          <>
            <span style={{ textTransform: 'capitalize', color: roleColor(role.name) }}>{role.name}</span>
            <span class="pill" style={{ color: 'var(--color-mut)', background: '#8b929e1a' }}>
              pool role
            </span>
            {role.model && (
              <span class="pill" style={{ color: 'var(--color-mut2)', background: '#8b929e14', fontFamily: 'ui-monospace,Menlo,monospace' }}>
                {role.model}
              </span>
            )}
          </>
        ) : item ? (
          <>
            {item.identifier}
            <span class="pill" style={{ color: SC(item.state), background: SC(item.state) + '22' }}>
              {item.state}
            </span>
            {item.prUrl && (
              <a class="pr" href={item.prUrl} target="_blank" rel="noopener">
                PR #{prNum}
              </a>
            )}
            {item.url && (
              <a class="pr" style={{ background: '#8b929e1a', color: 'var(--color-mut)' }} href={item.url} target="_blank" rel="noopener">
                Linear ↗
              </a>
            )}
          </>
        ) : null}
      </span>
      <span
        id="mclose"
        role="button"
        tabIndex={0}
        aria-label="Close"
        class="ml-auto cursor-pointer text-mut text-[12.5px] hover:text-fg"
        onClick={onClose}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClose()}
      >
        close ✕
      </span>
    </div>
  )
}

function ModalSub({ item, role }: { item: BoardItem | null; role: RoleItem | null }) {
  if (role) {
    const live = role.status === 'running'
    const meta: ComponentChildren[] = [
      <span class="inline-flex items-center gap-[5px] [font-variant-numeric:tabular-nums]" key="status">
        <i class="dot" style={{ background: live ? '#3fb27f' : 'var(--color-mut2)' }} />
        {live ? 'working' : 'idle'}
      </span>,
      <span class="inline-flex items-center gap-[5px] [font-variant-numeric:tabular-nums]" key="cadence">↻ every {ago(role.cadenceMs)}</span>,
    ]
    if (role.maxPerDay != null)
      meta.push(
        <span class="inline-flex items-center gap-[5px] [font-variant-numeric:tabular-nums]" key="filed">
          {role.filedToday}/{role.maxPerDay + (role.granted || 0)} filed today{(role.granted || 0) > 0 ? ` (+${role.granted} granted)` : ''}
        </span>,
      )
    if (role.lastRunAt)
      meta.push(
        <span class="inline-flex items-center gap-[5px] [font-variant-numeric:tabular-nums]" key="lastRun">
          last run {ago(Date.now() - role.lastRunAt)} ago
        </span>,
      )
    if (role.tokens)
      meta.push(
        <span class="inline-flex items-center gap-[5px] [font-variant-numeric:tabular-nums]" key="tokens">
          Σ {fmtTok(role.tokens)} tok
        </span>,
      )
    if (role.host)
      meta.push(
        <span class="inline-flex items-center gap-[5px] [font-variant-numeric:tabular-nums]" key="host">
          ⌂ {stripHostSuffix(role.host)}
        </span>,
      )
    return (
      <div id="msub" class="pt-[9px] px-4 pb-0">
        <div class="text-[14.5px] text-fg font-medium leading-[1.4]">{live ? role.activity || 'working…' : 'idle — waiting for the next run'}</div>
        <div class="flex gap-3 flex-wrap mt-[7px] text-mut text-[11.5px]">{meta}</div>
      </div>
    )
  }
  if (!item) return <div id="msub" class="pt-[9px] px-4 pb-0" />
  const m: ComponentChildren[] = []
  if (item.priority >= 1 && item.priority <= 4)
    m.push(
      <span class="inline-flex items-center gap-[5px] [font-variant-numeric:tabular-nums]" key="priority">
        <i class={`pri p${item.priority} !mr-0`} />
        {PRI[item.priority]}
      </span>,
    )
  if (item.enteredAt)
    m.push(
      <span class="inline-flex items-center gap-[5px] [font-variant-numeric:tabular-nums]" key="elapsed" title="total time in the factory">
        ⏱ {item.endedAt ? ago(item.endedAt - item.enteredAt) : <span data-since={item.enteredAt}>{ago(Date.now() - item.enteredAt)}</span>}
      </span>,
    )
  if (item.status === 'running')
    m.push(
      <span class="inline-flex items-center gap-[5px] [font-variant-numeric:tabular-nums]" key="turn">
        ⏺ turn {item.turn || 0}
      </span>,
    )
  if (item.host)
    m.push(
      <span class="inline-flex items-center gap-[5px] [font-variant-numeric:tabular-nums]" key="host">
        ⌂ {stripHostSuffix(item.host)}
      </span>,
    )
  if (item.tokens)
    m.push(
      <span class="inline-flex items-center gap-[5px] [font-variant-numeric:tabular-nums]" key="tokens" title="total tokens">
        Σ {fmtTok(item.tokens.total)} tok
      </span>,
    )
  return (
    <div id="msub" class="pt-[9px] px-4 pb-0">
      <div class="text-[14.5px] text-fg font-medium leading-[1.4]">{item.title || ''}</div>
      {m.length > 0 && <div class="flex gap-3 flex-wrap mt-[7px] text-mut text-[11.5px]">{m}</div>}
    </div>
  )
}

function ModalBanner({ item, isRole }: { item: BoardItem | null; isRole: boolean }) {
  const base = 'mt-[11px] mx-4 mb-0 px-3 py-[9px] rounded-[9px] text-[12.5px] leading-[1.5]'
  if (isRole || !item) return <div id="mbanner" style={{ display: 'none' }} />
  if (item.state === 'Factory - Needs Engineer') {
    return (
      <div id="mbanner" class={`${base} bg-[#e0564f18] border border-[#e0564f44] text-danger-text`}>
        <b class="text-danger">⚠ Factory - Needs Engineer</b> — {item.note || 'open the workpad in Linear for the decision needed'}
      </div>
    )
  }
  if (item.note && item.status !== 'running') {
    return (
      <div id="mbanner" class={`${base} bg-surf2 border border-line text-mut`}>
        {item.note}
      </div>
    )
  }
  return <div id="mbanner" style={{ display: 'none' }} />
}

function ModalTokens({ item, isRole }: { item: BoardItem | null; isRole: boolean }) {
  if (isRole || !item || !item.tokens) return <div id="mtokens" style={{ display: 'none' }} />
  let tcached = 0
  let tinput = 0
  let toutput = 0
  for (const p of item.tokens.phases) {
    tcached += p.cached
    tinput += p.input
    toutput += p.output
  }
  const mc = estCost(tinput, toutput, tcached)
  return (
    <div id="mtokens" class="mt-[11px] mx-4 mb-0 flex items-center gap-[7px] flex-wrap text-xs">
      <span class="uppercase tracking-[.5px] text-[10px] text-mut2">tokens</span>
      {item.tokens.phases.map((p) => (
        <span
          key={p.phase}
          class="bg-surf2 border border-line rounded-md px-2 py-0.5 text-mut font-mono"
          title={`input ${fmtTok(p.input)} · output ${fmtTok(p.output)} · cached ${fmtTok(p.cached)} · ~${fmtCost(estCost(p.input, p.output, p.cached))} API-equiv`}
        >
          <b class="text-fg font-semibold capitalize">{p.phase}</b> {fmtTok(p.total)}
        </span>
      ))}
      <span class="ml-auto text-fg font-mono font-semibold">
        Σ {fmtTok(item.tokens.total)}
        {tinput > 0 && (
          <>
            {' '}
            &middot; <b style={{ color: '#3fb27f' }}>{fmtTok(tcached)} cached</b>
          </>
        )}{' '}
        &middot; <span title="what this ticket would cost at GPT-5.5 API rates; actual spend is flat, not per-token">~{fmtCost(mc)} at API rates</span>
      </span>
    </div>
  )
}

function ModalActions({
  item,
  isRole,
  onAction,
  onMoveMenu,
  busy,
}: {
  item: BoardItem | null
  isRole: boolean
  onAction: (id: string, action: string) => void
  onMoveMenu: (id: string, ev: MouseEvent) => void
  busy: boolean
}) {
  if (isRole || !item) return <div id="mactions" style={{ display: 'none' }} />
  const acts = actionList(item)
  const base =
    'font-semibold text-xs/[1] font-[inherit] rounded-lg px-[13px] py-2 cursor-pointer transition-[background,border-color] duration-[120ms] motion-safe:active:scale-[.97] motion-safe:active:opacity-[.85]'
  const busyCls = busy ? ' opacity-60 pointer-events-none' : ''
  return (
    <div id="mactions" class="flex gap-2 flex-wrap mt-[9px] mx-4 mb-3.5">
      {acts.map((d) => (
        <button
          key={d.a}
          class={`${base} ${
            d.c === 'go'
              ? 'text-[#9ec1ff] bg-surf2 border border-[#5b8def55] hover:bg-accent-glow hover:border-[#3a4150]'
              : d.c === 'danger'
                ? 'text-danger-text bg-surf2 border border-[#e0564f55] hover:bg-[#e0564f1a] hover:border-[#3a4150]'
                : 'text-fg bg-surf2 border border-line2 hover:bg-[#2a2f3a] hover:border-[#3a4150]'
          }${busyCls}`}
          title={d.t || ''}
          onClick={() => onAction(item.identifier, d.a)}
        >
          {d.l}
        </button>
      ))}
      <button
        class={`${base} text-fg bg-surf2 border border-line2 hover:bg-[#2a2f3a] hover:border-[#3a4150]${busyCls}`}
        data-id={item.identifier}
        onClick={(e) => onMoveMenu(item.identifier, e)}
        title="move this ticket to any column"
      >
        ⋯
      </button>
    </div>
  )
}
