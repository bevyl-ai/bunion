import type { BoardColumn } from '../lib/types'

// Item 7: a persistent strip below the header, one chip per board column with its live count. Solves a real
// first-impression problem — at normal desktop width the board needs ~3000px but only ~1600px is visible, and
// columns with actual backlog (Needs Engineer, Ready) sit off-screen with zero cue otherwise.
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
