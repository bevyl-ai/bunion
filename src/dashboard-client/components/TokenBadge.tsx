import { estCost, fmtCost, fmtTok } from '../lib/format'
import type { TokenBreakdown } from '../lib/types'

// Totals >= 1e9 are almost certainly the pre-db510f7 double-counting bug (thread-cumulative
// tokens re-folded onto a tally that already had them), not a real spend — flag it visibly
// rather than let the number pass as trustworthy.
export function TokenBadge({ tokens }: { tokens: TokenBreakdown | null }) {
  if (!tokens) return <span class="t-tok" />
  const input = tokens.phases.reduce((a, p) => a + p.input, 0)
  const output = tokens.phases.reduce((a, p) => a + p.output, 0)
  const cached = tokens.phases.reduce((a, p) => a + p.cached, 0)
  const cost = estCost(input, output, cached)
  const stale = tokens.total >= 1e9
  const title =
    `${fmtTok(tokens.total)} tokens · ~${fmtCost(cost)} at API rates · flat plan, not per-token` +
    (stale ? ' · ⚠ likely inflated by pre-fix accounting bug (see db510f7) — do not trust this number at face value' : '')
  return (
    <span class={`t-tok clk${stale ? ' tok-stale' : ''}`} title={title}>
      {stale ? '⚠ ' : ''}
      {fmtTok(tokens.total)} tok
    </span>
  )
}
