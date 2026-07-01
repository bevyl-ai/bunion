import type { BoardColumn } from '../lib/types'

// The board is much wider than the viewport, so columns with real backlog can sit off-screen with no cue;
// this strip surfaces a live count per column so an operator can jump straight to it.
export function JumpBar({ cols, counts, onJump }: { cols: BoardColumn[]; counts: number[]; onJump: (index: number) => void }) {
  return (
    <div id="jumpbar" role="tablist" aria-label="Jump to board column">
      {cols.map((col, i) => {
        const n = counts[i] ?? 0
        const has = n > 0
        const inertHas = !!col.inert && has
        return (
          <button
            key={col.name}
            type="button"
            class={`jumpchip${has ? ' has' : ''}${inertHas ? ' inert-has' : ''}`}
            onClick={() => onJump(i)}
            title={`${col.name} — ${n} ticket${n === 1 ? '' : 's'}`}
          >
            <i style={{ background: col.c }} />
            {col.name}
            <span class="jn">{n}</span>
          </button>
        )
      })}
    </div>
  )
}
