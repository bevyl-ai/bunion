import type { RefObject } from 'preact'
import { useLayoutEffect, useRef } from 'preact/hooks'

// FLIP-style position-transition animation. Triggered only when `sig` changes (a structural signature the
// caller computes — see boardSignature in Board.tsx); live in-place field updates never touch `sig`, so this
// hook never fires for those. Entirely skipped when prefers-reduced-motion is set.
export function useFlip(containerRef: RefObject<HTMLElement>, sig: string): void {
  const prevRects = useRef<Map<string, DOMRect>>(new Map())
  const prevSig = useRef<string | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const cards = Array.from(container.querySelectorAll<HTMLElement>('.card[data-id]'))

    if (motion && prevSig.current !== null && prevSig.current !== sig) {
      const first = prevRects.current
      for (const c of cards) {
        const id = c.getAttribute('data-id')
        if (!id) continue
        const f = first.get(id)
        if (!f) continue
        const l = c.getBoundingClientRect()
        const dx = f.left - l.left
        const dy = f.top - l.top
        if (!dx && !dy) continue
        c.classList.add('flipping')
        c.style.transition = 'none'
        c.style.transform = `translate(${dx}px,${dy}px)`
        requestAnimationFrame(() => {
          c.style.transition = 'transform .32s cubic-bezier(.2,.7,.2,1)'
          c.style.transform = ''
        })
        const onEnd = (): void => {
          c.style.transition = ''
          c.style.transform = ''
          c.classList.remove('flipping')
          c.removeEventListener('transitionend', onEnd)
        }
        c.addEventListener('transitionend', onEnd)
      }
    }

    // Record post-render rects for the NEXT structural change (measured after this render's DOM is committed).
    const next = new Map<string, DOMRect>()
    for (const c of cards) {
      const id = c.getAttribute('data-id')
      if (id) next.set(id, c.getBoundingClientRect())
    }
    prevRects.current = next
    prevSig.current = sig
  }, [sig])
}
