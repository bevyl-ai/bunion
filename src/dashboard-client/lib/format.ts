// Keep the cost constants below in sync with the server-side src/tokens.ts RATES if either changes.

// State-name -> pill color.
const STATE_COLORS: Record<string, string> = {
  Triage: '#7c8493',
  Backlog: '#7c8493',
  Todo: '#7c8493',
  'In Progress': '#5b8def',
  'QA Requested': '#d9a441',
  'QA Testing': '#d99a2b',
  'QA Verify': '#c79a3a',
  'QA blocked': '#e0564f',
  'Needs Engineer': '#d9568c',
  'STG - Ready to merge': '#3fb27f',
  Done: '#a371f7',
}
export const SC = (s: string): string => STATE_COLORS[s] || '#7c8493'

export const ago = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ' + (s % 60) + 's'
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'
}

export const fmtTok = (n: number | null | undefined): string => {
  n = n || 0
  return n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n)
}

// API-equivalent $ at ~GPT-5.5 rates ($ per 1M tokens) — what this volume WOULD cost on the OpenAI API. Actual
// spend is flat (the exe.dev plan + a ChatGPT subscription), NOT per-token, so this is value extracted, not a bill.
const COST_IN = 5
const COST_CACHED = 0.5
const COST_OUT = 30
export function estCost(input: number, output: number, cached: number): number {
  const unc = Math.max(0, (input || 0) - (cached || 0))
  return (unc * COST_IN + (cached || 0) * COST_CACHED + (output || 0) * COST_OUT) / 1e6
}
export function fmtCost(d: number): string {
  return d >= 10000 ? '$' + Math.round(d / 1e3) + 'k' : d >= 100 ? '$' + Math.round(d) : d >= 1 ? '$' + d.toFixed(1) : '$' + d.toFixed(2)
}

export const PRI: Record<number, string> = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' }

export const stripHostSuffix = (h: string): string => h.replace(/\.exe\.xyz$/, '')
