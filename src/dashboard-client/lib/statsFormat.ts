// The stats page's own fmtTok/dur — ported byte-faithfully from the old STATS_HTML inline <script>. Deliberately
// NOT reusing the board's fmtTok (lib/format.ts): the stats page's version has slightly different thresholds
// (no k-suffix step, coarser M rounding) and diverging them here matches production behavior exactly.
export function fmtTokStats(n: number | null | undefined): string {
  n = n || 0
  return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n)
}

export function dur(ms: number | null | undefined): string {
  ms = ms || 0
  const m = Math.round(ms / 60000)
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '')
}

// Outcome-color map, reproduced exactly from the old STATS_HTML's `OC`.
const OC: Record<string, string> = {
  Done: 'var(--purple)',
  'STG - Ready to merge': 'var(--green)',
  'STG - Merged': 'var(--amber)',
  'Verifying in Prod': 'var(--accent)',
  'Needs Engineer': '#d9568c',
  'QA blocked': 'var(--red)',
}
export const oc = (s: string | null | undefined): string => (s ? OC[s] : undefined) || 'var(--mut2)'
