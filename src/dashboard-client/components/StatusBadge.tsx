import { ago, staleColor } from '../lib/format'
import type { BoardItem } from '../lib/types'

// The per-second-varying bits (running "active 12s" + its freshness dot, retry countdown) render their initial
// value here and carry a data- attribute; the vanilla ticker (lib/liveClock) repaints just those each second.
// Day-granularity displays (NE/ready "1.3d") compute from Date.now() at render and refresh on the next SSE push.
export function StatusBadge({ item }: { item: BoardItem }) {
  const r = item
  if (r.status === 'running') {
    const act = Date.now() - r.lastActivity
    return (
      <span class="ag t-ago inline-flex items-center gap-1.5 text-mut text-[11.5px] whitespace-nowrap">
        <i class="dot w-[7px] h-[7px] rounded-full" data-dot={r.lastActivity} style={{ background: staleColor(act) }} />
        active <span data-since={r.lastActivity}>{ago(act)}</span>
      </span>
    )
  }
  if (r.status === 'retrying')
    return (
      <span class="ag inline-flex items-center gap-1.5 text-mut text-[11.5px] whitespace-nowrap">
        ↻ retry {r.retryDueAt ? <>in <span data-until={r.retryDueAt}>{ago(r.retryDueAt - Date.now())}</span></> : 'soon'}
      </span>
    )

  if (r.state === 'Factory - Needs Engineer') {
    const neDays = r.enteredAt ? ((r.endedAt || Date.now()) - r.enteredAt) / 86400000 : 0
    if (neDays >= 2)
      return (
        <span class="ag ne-hot inline-flex items-center gap-1.5 text-[11.5px] whitespace-nowrap">
          ⚠⚠ factory - needs engineer &middot; {neDays.toFixed(1)}d ignored
        </span>
      )
    if (neDays >= 1)
      return (
        <span class="ag inline-flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-[#e0a020]">
          ⚠ factory - needs engineer &middot; {neDays.toFixed(1)}d
        </span>
      )
    return (
      <span class="ag inline-flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-[#d9568c]">
        ⚠ factory - needs engineer
      </span>
    )
  }

  if (r.state === 'Done')
    return (
      <span class="ag inline-flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-[#a371f7]">
        ✔ merged
      </span>
    )

  if (r.state === 'STG - Ready to merge') {
    const days = r.enteredAt ? ((r.endedAt || Date.now()) - r.enteredAt) / 86400000 : 0
    if (days >= 3)
      return (
        <span class="ag inline-flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-warn">
          ✔ ready &middot; {days.toFixed(1)}d waiting
        </span>
      )
    return (
      <span class="ag inline-flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-good">
        ✔ ready
      </span>
    )
  }

  if (r.status === 'handoff')
    return <span class="ag inline-flex items-center gap-1.5 text-mut text-[11.5px] whitespace-nowrap">✔ in review</span>
  return <span class="ag inline-flex items-center gap-1.5 text-mut text-[11.5px] whitespace-nowrap">⏳ queued</span>
}

export function isNeHot(item: BoardItem): boolean {
  return item.state === 'Factory - Needs Engineer' && !!item.enteredAt && ((item.endedAt || Date.now()) - item.enteredAt) / 86400000 >= 2
}
