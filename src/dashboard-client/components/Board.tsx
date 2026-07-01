import { useMemo, useRef } from 'preact/hooks'
import { colIdx } from '../lib/actions'
import type { BoardColumn, BoardItem } from '../lib/types'
import { Column } from './Column'
import { JumpBar } from './JumpBar'

export function Board({
  cols,
  items,
  effState,
  filterQuery,
  scope,
  terminalStates,
  onOpen,
  onKebab,
}: {
  cols: BoardColumn[]
  items: BoardItem[]
  effState: (identifier: string, actual: string) => string
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

  const counts = cols.map((_, i) => buckets[i]!.length)

  // Native, instant horizontal jump to a column — no smooth-scroll, no animation. Cards snap into place via
  // Preact's normal reconciliation on the next render.
  const jumpTo = (index: number): void => {
    const board = boardRef.current
    const el = colRefs.current.get(index)
    if (!board || !el) return
    board.scrollLeft = el.offsetLeft - 16
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
              onOpen={onOpen}
              onKebab={onKebab}
              colRef={(el) => {
                if (el) colRefs.current.set(i, el)
                else colRefs.current.delete(i)
              }}
            />
          ))}
          {unmapped.length > 0 && (
            <Column col={{ name: `⚠ unmapped — ${unmappedNames}`, c: '#e0564f', states: [] }} items={unmapped} onOpen={onOpen} onKebab={onKebab} />
          )}
        </div>
      )}
    </>
  )
}
