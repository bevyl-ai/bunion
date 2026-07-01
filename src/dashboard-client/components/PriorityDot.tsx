import { PRI } from '../lib/format'

// Relies on the `.pri` CSS class's default right margin for spacing in the identifier row — see styles.css.
export function PriorityDot({ priority }: { priority: number }) {
  if (!(priority >= 1 && priority <= 4)) return null
  return <i class={`pri p${priority}`} title={`${PRI[priority]} priority`} />
}
