import { useEffect, useRef, useState } from 'preact/hooks'
import type { ActionDef } from '../lib/types'

export interface MenuRequest {
  id: string
  items: ActionDef[]
  anchor: DOMRect
}

// Outside-click and resize dismissal is handled by global listeners in DashboardApp, not here — this
// component only positions and renders the menu for a given request.
export function ActionMenu({ request, onAction, onClose }: { request: MenuRequest | null; onAction: (id: string, action: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; visible: boolean }>({ left: 0, top: 0, visible: false })

  useEffect(() => {
    if (!request) {
      setPos((p) => ({ ...p, visible: false }))
      return
    }
    // The menu must already be in the DOM to read its real size, so it renders hidden first and is
    // repositioned + revealed once its dimensions are known.
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
      class="fixed z-[999] bg-surf2 border border-line2 rounded-[9px] p-[5px] shadow-[0_14px_36px_rgba(0,0,0,.55)] flex flex-col gap-0.5 min-w-[144px]"
      style={{ display: 'flex', visibility: pos.visible ? 'visible' : 'hidden', left: pos.left + 'px', top: pos.top + 'px' }}
      onClick={(e) => e.stopPropagation()}
    >
      {request.items.map((d) => (
        <button
          key={d.a}
          class={`block w-full text-left bg-none border-none text-fg font-semibold text-[12.5px]/[1] font-[inherit] px-[11px] py-2 rounded-md cursor-pointer whitespace-nowrap hover:bg-[#2a2f3a] ${d.c === 'go' ? 'text-[#9ec1ff]' : d.c === 'danger' ? 'text-danger-text' : ''}`}
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
