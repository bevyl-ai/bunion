import { ago } from '../lib/format'
import type { BoardItem } from '../lib/types'

export function StatusBadge({ item, now }: { item: BoardItem; now: number }) {
  const r = item
  if (r.status === 'running') {
    const act = now - r.lastActivity
    const dc = act < 30000 ? '#3fb27f' : act < 120000 ? '#d99a2b' : '#e0564f'
    return (
      <span class="ag t-ago inline-flex items-center gap-1.5 text-mut text-[11.5px] whitespace-nowrap">
        <i class="dot w-[7px] h-[7px] rounded-full" style={{ background: dc }} />
        active {ago(act)}
      </span>
    )
  }
  if (r.status === 'retrying')
    return (
      <span class="ag inline-flex items-center gap-1.5 text-mut text-[11.5px] whitespace-nowrap">
        ↻ retry {r.retryDueAt ? 'in ' + ago(r.retryDueAt - now) : 'soon'}
      </span>
    )

  if (r.state === 'Needs Engineer') {
    const neDays = r.enteredAt ? ((r.endedAt || now) - r.enteredAt) / 86400000 : 0
    if (neDays >= 2)
      return (
        <span class="ag ne-hot inline-flex items-center gap-1.5 text-[11.5px] whitespace-nowrap">
          ⚠⚠ needs engineer &middot; {neDays.toFixed(1)}d ignored
        </span>
      )
    if (neDays >= 1)
      return (
        <span class="ag inline-flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-[#e0a020]">
          ⚠ needs engineer &middot; {neDays.toFixed(1)}d
        </span>
      )
    return (
      <span class="ag inline-flex items-center gap-1.5 text-[11.5px] whitespace-nowrap text-[#d9568c]">
        ⚠ needs engineer
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
    const days = r.enteredAt ? ((r.endedAt || now) - r.enteredAt) / 86400000 : 0
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

export function isNeHot(item: BoardItem, now: number): boolean {
  return item.state === 'Needs Engineer' && !!item.enteredAt && ((item.endedAt || now) - item.enteredAt) / 86400000 >= 2
}
