import { useEffect, useRef, useState } from 'preact/hooks'
import type { ActionDef } from '../lib/types'

export interface MenuRequest {
  id: string
  items: ActionDef[]
  anchor: DOMRect
}

// Item 31: the floating menu shared by the card kebab AND the modal's "..." move-to-any-column button.
// Right-aligned to its anchor button, flips upward if it would overflow the viewport bottom. Closes on outside
// click, scroll, or resize (item 31) — those listeners are global and owned by DashboardApp; this component is
// purely presentational once a MenuRequest is supplied.
export function ActionMenu({ request, onAction, onClose }: { request: MenuRequest | null; onAction: (id: string, action: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; visible: boolean }>({ left: 0, top: 0, visible: false })

  useEffect(() => {
    if (!request) {
      setPos((p) => ({ ...p, visible: false }))
      return
    }
    // Measure after mount (menu must be in the DOM, hidden, to get its real size) — mirrors the old showMenu()'s
    // visibility:hidden measure-then-place trick.
    const m = ref.current
    if (!m) return
    const mw = m.offsetWidth
    const mh = m.offsetHeight
    const r = request.anchor
    let left = Math.max(8, r.right - mw)
    let top = r.bottom + 5
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 5)
    setPos({ left, top, visible: true })
  }, [request])

  if (!request) return null

  return (
    <div
      id="actmenu"
      ref={ref}
      style={{ display: 'flex', visibility: pos.visible ? 'visible' : 'hidden', left: pos.left + 'px', top: pos.top + 'px' }}
      onClick={(e) => e.stopPropagation()}
    >
      {request.items.map((d) => (
        <button
          key={d.a}
          class={`actitem ${d.c || ''}`}
          title={d.t || ''}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onClose()
            onAction(request.id, d.a)
          }}
        >
          {d.l}
        </button>
      ))}
    </div>
  )
}
