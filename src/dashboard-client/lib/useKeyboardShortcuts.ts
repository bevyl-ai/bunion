import { useEffect } from 'preact/hooks'

// Items 54-56: p/P triggers pause, j/k moves focus between cards (wrapping-safe at the ends), Enter opens the
// focused card's modal. All suppressed while focus is inside a text input/textarea, and j/k/Enter card-nav is
// also suppressed while the modal is open (no card grid visible then — Modal owns its own Escape/ArrowUp/Down).
export function useKeyboardShortcuts({ modalOpen, onPause, onOpen }: { modalOpen: boolean; onPause: () => void; onOpen: (id: string) => void }): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const ae = (document.activeElement || {}) as HTMLElement
      if (/^(TEXTAREA|INPUT)$/.test(ae.tagName || '')) return
      if (modalOpen) return // Escape/Arrow keys inside the modal are owned by Modal's own listener
      if (e.key === 'p' || e.key === 'P') {
        onPause()
        return
      }
      if (e.key === 'j' || e.key === 'k') {
        const cards = Array.from(document.querySelectorAll<HTMLElement>('#board .card[data-id]'))
        if (!cards.length) return
        const cur = ae.closest ? (ae.closest('.card') as HTMLElement | null) : null
        const idx = cards.indexOf(cur as HTMLElement)
        let nx = e.key === 'j' ? idx + 1 : idx - 1
        if (nx < 0) nx = 0
        if (nx >= cards.length) nx = cards.length - 1
        cards.forEach((c) => c.classList.remove('kbfocus'))
        const t = cards[nx]
        if (t) {
          t.classList.add('kbfocus')
          t.focus()
          t.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
        e.preventDefault()
        return
      }
      if (e.key === 'Enter') {
        const f = ae.closest ? (ae.closest('.card[data-id]') as HTMLElement | null) : null
        if (f) {
          const id = f.getAttribute('data-id')
          if (id) onOpen(id)
          e.preventDefault()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [modalOpen, onPause, onOpen])
}
