import { useMemo, useRef } from 'preact/hooks'
import { colIdx } from '../lib/actions'
import { useFlip } from '../lib/useFlip'
import type { BoardColumn, BoardItem } from '../lib/types'
import { Column } from './Column'
import { JumpBar } from './JumpBar'

export function Board({
  cols,
  items,
  effState,
  now,
  filterQuery,
  scope,
  terminalStates,
  onOpen,
  onKebab,
}: {
  cols: BoardColumn[]
  items: BoardItem[]
  effState: (identifier: string, actual: string) => string
  now: number
  filterQuery: string
  scope: string
  terminalStates: string[] | undefined
  onOpen: (id: string) => void
  onKebab: (id: string, ev: MouseEvent) => void
}) {
  const boardRef = useRef<HTMLDivElement | null>(null)
  const colRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  const filtered = useMemo(() => {
    if (!filterQuery) return items
    return items.filter((r) => (r.identifier + ' ' + (r.title || '') + ' ' + (r.host || '') + ' ' + (r.state || '')).toLowerCase().indexOf(filterQuery) >= 0)
  }, [items, filterQuery])

  const { buckets, unmapped } = useMemo(() => {
    const bk: BoardItem[][] = cols.map(() => [])
    const unmapped: BoardItem[] = []
    const term = (terminalStates || []).map((s) => s.toLowerCase())
    for (const r of filtered) {
      const st = effState(r.identifier, r.state)
      // Substitute the optimistic (pre-confirmation) state into the item object itself so the card's bucket
      // placement AND its rendered badge/column both reflect the override, not just the internal bookkeeping.
      const eff = st === r.state ? r : { ...r, state: st }
      const i = colIdx(cols, st)
      if (i >= 0) bk[i]!.push(eff)
      else if (term.indexOf(st.toLowerCase()) < 0) unmapped.push(eff)
    }
    // Factory - Needs Engineer + Ready (states containing STG - Ready to merge) sort oldest-entered-first.
    cols.forEach((col, i) => {
      const isNe = col.name === 'Factory - Needs Engineer'
      const isReady = col.states.some((s) => s === 'STG - Ready to merge')
      if (isNe || isReady) bk[i]!.sort((a, b) => (a.enteredAt || 0) - (b.enteredAt || 0))
    })
    return { buckets: bk, unmapped }
  }, [cols, filtered, effState, terminalStates])

  // Structural signature: rebuild only on membership/state/status/pr/QA-note changes; live field ticks never
  // touch this, so the FLIP hook + full column re-render is skipped for per-second updates.
  const sig = useMemo(() => {
    const key = filtered.map((r) => {
      const st = effState(r.identifier, r.state)
      return [r.identifier, st, r.status, r.host, r.prUrl, r.retryAttempt, st === 'QA - blocked' ? r.note || '' : ''].join('')
    })
    return key.join('') + '|' + filterQuery
  }, [filtered, effState, filterQuery])

  useFlip(boardRef, sig)

  const counts = cols.map((_, i) => buckets[i]!.length)

  const jumpTo = (index: number): void => {
    const board = boardRef.current
    const el = colRefs.current.get(index)
    if (!board || !el) return
    const target = el.offsetLeft - 16
    const before = board.scrollLeft
    board.scrollTo({ left: target, behavior: 'smooth' })
    // Chromium suspends the compositor-driven smooth-scroll animation on a backgrounded/hidden tab, so a
    // click landing while the tab isn't visible can silently no-op. Verify shortly after that the scroll
    // actually progressed and snap instantly as a fallback if it didn't — belt-and-suspenders, does not
    // change the smooth-scroll behavior a normal focused/visible tab sees.
    setTimeout(() => {
      if (Math.abs(board.scrollLeft - before) < 1 && Math.abs(board.scrollLeft - target) > 1) {
        board.scrollTo({ left: target, behavior: 'instant' as ScrollBehavior })
      }
    }, 200)
  }

  const unmappedNames = unmapped.length ? [...new Set(unmapped.map((r) => effState(r.identifier, r.state)))].join(', ') : ''

  return (
    <>
      <JumpBar cols={cols} counts={counts} onJump={jumpTo} />
      {!filtered.length ? (
        <div class="board" id="board" ref={boardRef}>
          <div class="empty">{filterQuery ? `no tickets match "${filterQuery}"` : `no ${scope || 'dark-factory'} tickets in scope`}</div>
        </div>
      ) : (
        <div class="board" id="board" ref={boardRef}>
          {cols.map((col, i) => (
            <Column
              key={col.name}
              col={col}
              items={buckets[i]!}
              now={now}
              onOpen={onOpen}
              onKebab={onKebab}
              colRef={(el) => {
                if (el) colRefs.current.set(i, el)
                else colRefs.current.delete(i)
              }}
            />
          ))}
          {unmapped.length > 0 && (
            <Column col={{ name: `⚠ unmapped — ${unmappedNames}`, c: '#e0564f', states: [] }} items={unmapped} now={now} onOpen={onOpen} onKebab={onKebab} />
          )}
        </div>
      )}
    </>
  )
}
