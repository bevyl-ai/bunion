import { ago } from '../lib/format'
import type { BoardItem } from '../lib/types'

// Item 23: bottom-left status badge, first-matching-rule-wins cascade ported exactly from the old `cardHtml`.
export function StatusBadge({ item, now }: { item: BoardItem; now: number }) {
  const r = item
  if (r.status === 'running') {
    const act = now - r.lastActivity
    const dc = act < 30000 ? '#3fb27f' : act < 120000 ? '#d99a2b' : '#e0564f'
    return (
      <span class="ag t-ago">
        <i class="dot" style={{ background: dc }} />
        active {ago(act)}
      </span>
    )
  }
  if (r.status === 'retrying') return <span class="ag">↻ retry {r.retryDueAt ? 'in ' + ago(r.retryDueAt - now) : 'soon'}</span>

  if (r.state === 'Needs Engineer') {
    const neDays = r.enteredAt ? ((r.endedAt || now) - r.enteredAt) / 86400000 : 0
    if (neDays >= 2)
      return (
        <span class="ag ne-hot">
          ⚠⚠ needs engineer &middot; {neDays.toFixed(1)}d ignored
        </span>
      )
    if (neDays >= 1)
      return (
        <span class="ag" style={{ color: '#e0a020' }}>
          ⚠ needs engineer &middot; {neDays.toFixed(1)}d
        </span>
      )
    return (
      <span class="ag" style={{ color: '#d9568c' }}>
        ⚠ needs engineer
      </span>
    )
  }

  if (r.state === 'Done')
    return (
      <span class="ag" style={{ color: '#a371f7' }}>
        ✔ merged
      </span>
    )

  if (r.state === 'STG - Ready to merge') {
    const days = r.enteredAt ? ((r.endedAt || now) - r.enteredAt) / 86400000 : 0
    if (days >= 3)
      return (
        <span class="ag" style={{ color: '#d99a2b' }}>
          ✔ ready &middot; {days.toFixed(1)}d waiting
        </span>
      )
    return (
      <span class="ag" style={{ color: '#3fb27f' }}>
        ✔ ready
      </span>
    )
  }

  if (r.status === 'handoff') return <span class="ag">✔ in review</span>
  return <span class="ag">⏳ queued</span>
}

// Whether a card gets the hot-red pulsing left-border/box-shadow treatment (item 23c, >= 2 days in Needs Engineer).
export function isNeHot(item: BoardItem, now: number): boolean {
  return item.state === 'Needs Engineer' && !!item.enteredAt && ((item.endedAt || now) - item.enteredAt) / 86400000 >= 2
}
