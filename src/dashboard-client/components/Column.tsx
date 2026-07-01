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
    <div class={`col${inert ? ' inert' : ''} flex-[0_0_256px] max-w-64 min-w-0 flex flex-col gap-2.5 min-h-0`} ref={colRef}>
      <div class="colh flex items-center gap-2 pt-0.5 px-1 pb-[9px] text-[11px] font-bold text-mut tracking-[.7px] uppercase">
        <i class="w-2 h-2 rounded-full" style={{ background: col.c }} />
        {col.name}
        {inert && (
          <span
            class="parked ml-2 text-[9px] font-bold tracking-[.5px] uppercase text-mut2 bg-surf2 border border-line rounded-[5px] px-1.5 py-px"
            title="the factory does not work these — they wait on a person, the release train, or are already done"
          >
            parked
          </span>
        )}
        <span class="ct ml-auto text-mut font-semibold [font-variant-numeric:tabular-nums] bg-surf2 border border-line rounded-[20px] min-w-[22px] text-center px-[7px] py-px text-[10.5px] tracking-normal">
          {items.length}
        </span>
      </div>
      <div class="colcards flex flex-col gap-2.5 flex-auto overflow-y-auto overflow-x-hidden min-h-0 pb-2">
        {items.length ? (
          items.map((r) => <Card key={r.identifier} item={r} now={now} onOpen={onOpen} onKebab={onKebab} />)
        ) : (
          <div class="colempty text-[#3a414e] text-[11.5px] py-4 text-center border border-dashed border-line rounded-[10px]">empty</div>
        )}
      </div>
    </div>
  )
}
