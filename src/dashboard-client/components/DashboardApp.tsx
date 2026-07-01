import { useEffect, useMemo, useState } from 'preact/hooks'
import { actionList, moveItems } from '../lib/actions'
import { useActions } from '../lib/useActions'
import { useKeyboardShortcuts } from '../lib/useKeyboardShortcuts'
import { useSnapshot } from '../lib/useSnapshot'
import { useToast } from '../lib/useToast'
import type { ActionDef } from '../lib/types'
import { ActionMenu, type MenuRequest } from './ActionMenu'
import { Board } from './Board'
import { Header, PauseBanner } from './Header'
import { Modal } from './Modal'
import { RoleDock } from './RoleDock'
import { Toast } from './Toast'

export function DashboardApp() {
  const { snap, cols, setSnap } = useSnapshot()
  const { toast, showToast } = useToast()
  const [searchInput, setSearchInput] = useState('') // raw text as typed, bound to the controlled input's value
  const filterQuery = searchInput.trim().toLowerCase() // normalized query the Board matches against (item 3)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuRequest | null>(null)
  const [chatPending, setChatPending] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // Item 26: tick every second for live in-place field updates (card elapsed/active/turn/token text) without
  // forcing the structural board rebuild (Board.tsx's `sig` doesn't depend on `now`). Also drives the
  // optimistic-override sweep in useActions (item 33's 5s expiry).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const { effState, postAction, busyIds } = useActions(snap, setSnap, showToast, now)

  const effItem = useMemo(() => {
    if (!expandedId) return null
    const it = snap.items.find((x) => x.identifier === expandedId)
    if (!it) return null
    const st = effState(expandedId, it.state)
    return st === it.state ? it : { ...it, state: st }
  }, [expandedId, snap.items, effState])

  const effRole = useMemo(() => (expandedId ? snap.roles.find((r) => r.name === expandedId) || null : null), [expandedId, snap.roles])

  // A ticket modal takes priority; if neither matches (e.g. a role name coincides with nothing), nothing renders.
  const modalItem = effRole ? null : effItem
  const modalRole = effRole

  const openModal = (id: string): void => {
    setExpandedId(id)
    setChatPending(false)
  }
  const closeModal = (): void => setExpandedId(null)

  const closeMenu = (): void => setMenu(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      const t = e.target as HTMLElement
      if (!t.closest('#actmenu') && !t.closest('.kebab') && !t.closest('.mmore')) closeMenu()
    }
    const onScroll = (): void => closeMenu()
    const onResize = (): void => closeMenu()
    document.addEventListener('click', onDocClick)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('click', onDocClick)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  const openKebabMenu = (id: string, ev: MouseEvent): void => {
    ev.preventDefault()
    ev.stopPropagation()
    if (menu && menu.id === id) {
      closeMenu()
      return
    }
    const it = snap.items.find((x) => x.identifier === id)
    const items: ActionDef[] = [...actionList(it), ...moveItems(cols, it)]
    if (!items.length) {
      closeMenu()
      return
    }
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ id, items, anchor: rect })
  }

  const openMoveMenu = (id: string, ev: MouseEvent): void => {
    ev.preventDefault()
    ev.stopPropagation()
    if (menu && menu.id === id) {
      closeMenu()
      return
    }
    const it = snap.items.find((x) => x.identifier === id)
    const items = moveItems(cols, it)
    if (!items.length) {
      closeMenu()
      return
    }
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ id, items, anchor: rect })
  }

  const handleAction = (id: string, action: string): void => {
    void postAction(id, action)
  }

  const handleChat = async (id: string, text: string): Promise<void> => {
    setChatPending(true)
    try {
      const r = (await (
        await fetch('/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, text }) })
      ).json()) as { ok?: boolean; msg?: string }
      if (!(r && r.ok)) showToast('Chat: ' + ((r && r.msg) || 'failed'), true)
    } catch {
      showToast('Chat failed', true)
    }
    setChatPending(false)
  }

  useKeyboardShortcuts({
    modalOpen: !!expandedId,
    onPause: () => handleAction('__pause__', 'toggle'),
    onOpen: openModal,
  })

  return (
    <>
      <Header snap={snap} filterQuery={searchInput} onFilter={setSearchInput} onPause={() => handleAction('__pause__', 'toggle')} pauseBusy={busyIds.has('__pause__')} />
      <PauseBanner snap={snap} />
      <Board
        cols={cols}
        items={snap.items}
        effState={effState}
        now={now}
        filterQuery={filterQuery}
        scope={snap.scope}
        terminalStates={snap.terminalStates}
        onOpen={openModal}
        onKebab={openKebabMenu}
      />
      <RoleDock roles={snap.roles} onOpen={openModal} onAction={handleAction} busyIds={busyIds} />
      <Modal
        expandedId={expandedId}
        item={modalItem}
        role={modalRole}
        onClose={closeModal}
        onAction={handleAction}
        onMoveMenu={openMoveMenu}
        onChat={handleChat}
        chatPending={chatPending}
        busy={!!expandedId && busyIds.has(expandedId)}
      />
      <ActionMenu request={menu} onAction={handleAction} onClose={closeMenu} />
      <Toast toast={toast} />
    </>
  )
}
