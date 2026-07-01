import { PRI } from '../lib/format'

// Item 18: priority dot (p1=red/urgent through p4=gray/low), only rendered for priority 1-4. Relies on the
// `.pri` CSS default (6px right margin) for the card's identifier-row spacing — see styles.css.
export function PriorityDot({ priority }: { priority: number }) {
  if (!(priority >= 1 && priority <= 4)) return null
  return <i class={`pri p${priority}`} title={`${PRI[priority]} priority`} />
}
