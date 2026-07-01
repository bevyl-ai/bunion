import type { BoardColumn } from '../lib/types'

// The board is much wider than the viewport, so columns with real backlog can sit off-screen with no cue;
// this strip surfaces a live count per column so an operator can jump straight to it.
export function JumpBar({ cols, counts, onJump }: { cols: BoardColumn[]; counts: number[]; onJump: (index: number) => void }) {
  return (
    <div
      id="jumpbar"
      class="flex flex-none flex-wrap gap-1.5 border-b border-line bg-[rgba(11,12,17,0.5)] px-[22px] py-2"
      role="tablist"
      aria-label="Jump to board column"
    >
      {cols.map((col, i) => {
        const n = counts[i] ?? 0
        const has = n > 0
        const inertHas = !!col.inert && has
        return (
          <button
            key={col.name}
            type="button"
            class={`inline-flex cursor-pointer items-center gap-1.5 rounded-[20px] border border-line bg-surf py-[3px] pr-2.5 pl-2 text-[11px] font-semibold transition-[background,border-color,color] duration-[120ms] hover:border-line3 hover:bg-surf2 hover:text-fg ${
              has ? 'text-mut' : 'text-mut2'
            }${inertHas ? ' border-[#d9568c55]' : ''}`}
            onClick={() => onJump(i)}
            title={`${col.name} — ${n} ticket${n === 1 ? '' : 's'}`}
          >
            <i class={`h-1.5 w-1.5 rounded-full ${has ? 'opacity-100' : 'opacity-50'}`} style={{ background: col.c }} />
            {col.name}
            <span class={`min-w-[18px] rounded-[20px] border border-line bg-surf2 px-[5px] text-center text-[10px] ${has ? 'text-fg' : 'text-mut'}`}>
              {n}
            </span>
          </button>
        )
      })}
    </div>
  )
}
