import type { BoardColumn, BoardItem } from '../lib/types'
import { Card } from './Card'

export function Column({
  col,
  items,
  now,
  onOpen,
  onKebab,
  colRef,
}: {
  col: BoardColumn
  items: BoardItem[]
  now: number
  onOpen: (id: string) => void
  onKebab: (id: string, ev: MouseEvent) => void
  colRef?: (el: HTMLDivElement | null) => void
}) {
  const inert = !!col.inert
  return (
    <div class={`col${inert ? ' inert' : ''}`} ref={colRef}>
      <div class="colh">
        <i style={{ background: col.c }} />
        {col.name}
        {inert && (
          <span class="parked" title="the factory does not work these — they wait on a person, the release train, or are already done">
            parked
          </span>
        )}
        <span class="ct">{items.length}</span>
      </div>
      <div class="colcards">
        {items.length ? items.map((r) => <Card key={r.identifier} item={r} now={now} onOpen={onOpen} onKebab={onKebab} />) : <div class="colempty">empty</div>}
      </div>
    </div>
  )
}
