import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { actionList } from '../lib/actions'
import { ago, estCost, fmtCost, fmtTok, PRI, roleColor, SC, stripHostSuffix } from '../lib/format'
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
      <div id="mpanel" role="dialog" aria-modal="true" aria-labelledby="mtitle">
        <ModalHead item={item} role={role} onClose={onClose} />
        <ModalSub item={item} role={role} />
        <ModalBanner item={item} isRole={isRole} />
        <ModalTokens item={item} isRole={isRole} />
        <Transcript logRef={logRef} lines={lines} live={live} loaded={loaded} chatPending={chatPending} />
        <ChatBox
          placeholder={isRole && role ? `Prompt ${role.name} — steer it; it acts on its next run` : 'Message the agent — it can answer or act on steering (move state, update the plan)'}
          pending={chatPending}
          onSend={(text) => onChat(expandedId!, text)}
        />
        <ModalActions item={item} isRole={isRole} onAction={onAction} onMoveMenu={onMoveMenu} busy={busy} />
      </div>
    </div>
  )
}

function ModalHead({ item, role, onClose }: { item: BoardItem | null; role: RoleItem | null; onClose: () => void }) {
  const prNum = item?.prUrl ? item.prUrl.split('/pull/')[1] || '' : ''
  return (
    <div id="mhead">
      <span class="live" />
      <span id="mtitle">
        {role ? (
          <>
            <span style={{ textTransform: 'capitalize', color: roleColor(role.name) }}>{role.name}</span>
            <span class="pill" style={{ color: 'var(--mut)', background: '#8b929e1a' }}>
              pool role
            </span>
            {role.model && (
              <span class="pill" style={{ color: 'var(--mut2)', background: '#8b929e14', fontFamily: 'ui-monospace,Menlo,monospace' }}>
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
              <a class="pr" style={{ background: '#8b929e1a', color: 'var(--mut)' }} href={item.url} target="_blank" rel="noopener">
                Linear ↗
              </a>
            )}
          </>
        ) : null}
      </span>
      <span id="mclose" role="button" tabIndex={0} aria-label="Close" onClick={onClose} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onClose()}>
        close ✕
      </span>
    </div>
  )
}

function ModalSub({ item, role }: { item: BoardItem | null; role: RoleItem | null }) {
  if (role) {
    const live = role.status === 'running'
    const meta: ComponentChildren[] = [
      <span class="m" key="status">
        <i class="dot" style={{ background: live ? '#3fb27f' : 'var(--mut2)' }} />
        {live ? 'working' : 'idle'}
      </span>,
      <span class="m" key="cadence">↻ every {ago(role.cadenceMs)}</span>,
    ]
    if (role.maxPerDay != null)
      meta.push(
        <span class="m" key="filed">
          {role.filedToday}/{role.maxPerDay + (role.granted || 0)} filed today{(role.granted || 0) > 0 ? ` (+${role.granted} granted)` : ''}
        </span>,
      )
    if (role.lastRunAt) meta.push(<span class="m" key="lastRun">last run {ago(Date.now() - role.lastRunAt)} ago</span>)
    if (role.tokens) meta.push(<span class="m" key="tokens">Σ {fmtTok(role.tokens)} tok</span>)
    if (role.host) meta.push(<span class="m" key="host">⌂ {stripHostSuffix(role.host)}</span>)
    return (
      <div id="msub">
        <div class="mtitle2">{live ? role.activity || 'working…' : 'idle — waiting for the next run'}</div>
        <div class="mmeta">{meta}</div>
      </div>
    )
  }
  if (!item) return <div id="msub" />
  const m: ComponentChildren[] = []
  if (item.priority >= 1 && item.priority <= 4)
    m.push(
      <span class="m" key="priority">
        <i class={`pri p${item.priority}`} />
        {PRI[item.priority]}
      </span>,
    )
  if (item.enteredAt)
    m.push(
      <span class="m" key="elapsed" title="total time in the factory">
        ⏱ {ago((item.endedAt || Date.now()) - item.enteredAt)}
      </span>,
    )
  if (item.status === 'running') m.push(<span class="m" key="turn">⏺ turn {item.turn || 0}</span>)
  if (item.host) m.push(<span class="m" key="host">⌂ {stripHostSuffix(item.host)}</span>)
  if (item.tokens)
    m.push(
      <span class="m" key="tokens" title="total tokens">
        Σ {fmtTok(item.tokens.total)} tok
      </span>,
    )
  return (
    <div id="msub">
      <div class="mtitle2">{item.title || ''}</div>
      {m.length > 0 && <div class="mmeta">{m}</div>}
    </div>
  )
}

function ModalBanner({ item, isRole }: { item: BoardItem | null; isRole: boolean }) {
  if (isRole || !item) return <div id="mbanner" style={{ display: 'none' }} />
  if (item.state === 'Needs Engineer') {
    return (
      <div id="mbanner" class="nh">
        <b>⚠ Needs Engineer</b> — {item.note || 'open the workpad in Linear for the decision needed'}
      </div>
    )
  }
  if (item.note && item.status !== 'running') {
    return (
      <div id="mbanner" class="note">
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
    <div id="mtokens">
      <span class="tklab">tokens</span>
      {item.tokens.phases.map((p) => (
        <span key={p.phase} class="tkph" title={`input ${fmtTok(p.input)} · output ${fmtTok(p.output)} · cached ${fmtTok(p.cached)} · ~${fmtCost(estCost(p.input, p.output, p.cached))} API-equiv`}>
          <b>{p.phase}</b> {fmtTok(p.total)}
        </span>
      ))}
      <span class="tktot">
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
  return (
    <div id="mactions">
      {acts.map((d) => (
        <button key={d.a} class={`mbtn ${d.c || ''}${busy ? ' busy' : ''}`} title={d.t || ''} onClick={() => onAction(item.identifier, d.a)}>
          {d.l}
        </button>
      ))}
      <button class={`mbtn mmore${busy ? ' busy' : ''}`} data-id={item.identifier} onClick={(e) => onMoveMenu(item.identifier, e)} title="move this ticket to any column">
        ⋯
      </button>
    </div>
  )
}
