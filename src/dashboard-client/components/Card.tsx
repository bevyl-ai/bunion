import { actionList } from '../lib/actions'
import { ago, prNumFromUrl } from '../lib/format'
import { prefetchLog } from '../lib/useLogStream'
import type { BoardItem } from '../lib/types'
import { PriorityDot } from './PriorityDot'
import { StatusBadge, isNeHot } from './StatusBadge'
import { TokenBadge } from './TokenBadge'

export function Card({
  item,
  now,
  onOpen,
  onKebab,
}: {
  item: BoardItem
  now: number
  onOpen: (id: string) => void
  onKebab: (id: string, ev: MouseEvent) => void
}) {
  const r = item
  const run = r.status === 'running'
  const neHot = isNeHot(r, now)
  const prNum = prNumFromUrl(r.prUrl)
  const reason = (r.state === 'QA blocked' || r.state === 'Needs Engineer') && r.note ? r.note.slice(0, 160) : null
  const hasActions = actionList(r).length > 0

  return (
    <div
      class={`card${run ? ' run' : ''}${neHot ? ' ne-hot' : ''}`}
      data-id={r.identifier}
      tabIndex={0}
      aria-label={`Open ${r.identifier}`}
      onClick={() => onOpen(r.identifier)}
      onMouseOver={() => prefetchLog(r.identifier)}
    >
      <div class="ctop">
        <span class="cid">
          <PriorityDot priority={r.priority} />
          {r.identifier}
        </span>
        <span class="ctr">
          {r.prUrl && (
            <a class="pr" href={r.prUrl} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>
              #{prNum}
            </a>
          )}
          {hasActions && (
            <button class="kebab" data-id={r.identifier} onClick={(e) => onKebab(r.identifier, e)} title="actions" aria-label={`Actions for ${r.identifier}`} aria-haspopup="menu">
              ⋯
            </button>
          )}
        </span>
      </div>
      <div class="ctitle">{r.title}</div>
      {run && (
        <div class="cact t-act">
          turn {r.turn || 0} &middot; {(r.activity || '').slice(0, 70)}
        </div>
      )}
      {reason && (
        <div class="creason" title="why it is stuck">
          {reason}
        </div>
      )}
      <div class="cfoot">
        <StatusBadge item={r} now={now} />
        <span class="meta">
          <TokenBadge tokens={r.tokens} />
          {r.enteredAt && (
            <span class="t-tot clk" title="total time in the factory">
              ⏱ {ago((r.endedAt || now) - r.enteredAt)}
            </span>
          )}
        </span>
      </div>
    </div>
  )
}
