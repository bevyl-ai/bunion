// Deliberately not the board's fmtTok (lib/format.ts): this page uses coarser thresholds (no k-suffix
// step below 1e3, single-decimal M rounding) and the two must stay independent.
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

// Literal hex, not var(--color-x): callers append an alpha suffix (oc(x) + '22') to build the badge background,
// and "var(--color-x)22" is not a valid CSS color -- that silently dropped the background tint for every outcome
// except Factory - Needs Engineer (the one entry that was already a literal) since this table's first version.
const OC: Record<string, string> = {
  Done: '#a371f7',
  'STG - Ready to merge': '#3fb27f',
  'STG - Merged': '#d99a2b',
  'Verifying in Prod': '#5b8def',
  'Factory - Needs Engineer': '#d9568c',
  'QA - blocked': '#e0564f',
}
export const oc = (s: string | null | undefined): string => (s && OC[s]) || '#5a6270'
