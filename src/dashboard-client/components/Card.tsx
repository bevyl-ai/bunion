import { actionList } from '../lib/actions'
import { ago, prNumFromUrl, HUMAN_NOTE_STATES } from '../lib/format'
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
  const reason = HUMAN_NOTE_STATES.has(r.state) && r.note ? r.note.slice(0, 160) : null
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
      <div class="ctop flex items-center justify-between gap-2">
        <span class="cid font-[ui-monospace,SFMono-Regular,Menlo,monospace] text-[13px] font-[650] tracking-[-0.2px] text-fg">
          <PriorityDot priority={r.priority} />
          {r.identifier}
        </span>
        <span class="ctr inline-flex items-center gap-1.5 flex-none">
          {r.prUrl && (
            <a
              class="pr text-accent no-underline text-[11px] font-semibold bg-[#5b8def1a] px-[7px] py-0.5 rounded-md whitespace-nowrap hover:bg-[#5b8def2e]"
              href={r.prUrl}
              target="_blank"
              rel="noopener"
              onClick={(e) => e.stopPropagation()}
            >
              #{prNum}
            </a>
          )}
          {hasActions && (
            <button
              class="kebab bg-transparent border-none text-mut2 text-[15px] leading-none cursor-pointer px-[5px] py-px rounded-md hover:bg-surf2 hover:text-fg"
              data-id={r.identifier}
              onClick={(e) => onKebab(r.identifier, e)}
              title="actions"
              aria-label={`Actions for ${r.identifier}`}
              aria-haspopup="menu"
            >
              ⋯
            </button>
          )}
        </span>
      </div>
      <div class="ctitle text-mut text-[12.5px] mt-1.5 line-clamp-2 leading-[1.4]">{r.title}</div>
      {run && (
        <div class="cact t-act text-mut text-[11.5px] mt-[9px] truncate font-[ui-monospace,SFMono-Regular,Menlo,monospace]">
          turn {r.turn || 0} &middot; {(r.activity || '').slice(0, 70)}
        </div>
      )}
      {reason && (
        <div
          class="creason mt-2 text-[11.5px] text-danger-text bg-[#e0564f12] border border-[#e0564f33] rounded-[7px] px-2 py-1.5 leading-[1.45] line-clamp-3"
          title="why it is stuck"
        >
          {reason}
        </div>
      )}
      <div class="cfoot flex items-center justify-between gap-2 mt-[9px]">
        <StatusBadge item={r} now={now} />
        <span class="meta inline-flex items-center gap-2 min-w-0">
          <TokenBadge tokens={r.tokens} />
          {r.enteredAt && (
            <span
              class="t-tot clk text-mut2 text-[11px] [font-variant-numeric:tabular-nums] font-[ui-monospace,Menlo,monospace] whitespace-nowrap"
              title="total time in the factory"
            >
              ⏱ {ago((r.endedAt || now) - r.enteredAt)}
            </span>
          )}
        </span>
      </div>
    </div>
  )
}
