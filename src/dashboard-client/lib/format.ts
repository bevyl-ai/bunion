// Keep the cost constants below in sync with the server-side src/tokens.ts RATES if either changes.

// State-name -> pill color.
const STATE_COLORS: Record<string, string> = {
  Triage: '#7c8493',
  Backlog: '#7c8493',
  Todo: '#7c8493',
  'In Progress': '#5b8def',
  'QA - Testing': '#d99a2b',
  'QA - blocked': '#e0564f',
  'QA - Requested': '#d9a441',
  'Factory - UI review': '#b88cd9',
  'STG - Ready to merge': '#3fb27f',
  "Factory - can't verify": '#e0864f',
  'Factory - Needs Engineer': '#d9568c',
  Done: '#a371f7',
}
export const SC = (s: string): string => STATE_COLORS[s] || '#7c8493'

// Lanes whose `note` is a human-facing reason (why blocked / what to decide / the prod check to run / QA proof).
// The server hydrates the latest workpad note for exactly these lanes (see orchestrator note-fetch gate), so the
// card renders the note and the board change-signatures track it for exactly these lanes — keep the three in sync.
export const HUMAN_NOTE_STATES = new Set<string>([
  'QA - blocked',
  'Factory - Needs Engineer',
  'QA - Requested',
  'Factory - UI review',
  "Factory - can't verify",
  'STG - Ready to merge',
])

// Pool-role-name -> accent color.
export function roleColor(n: string): string {
  const name = (n || '').toLowerCase()
  return name === 'mechanic' ? '#d99a2b' : name === 'dreamer' ? '#b88cd9' : name === 'user-advocate' ? '#3fb29e' : '#5b8def'
}

export const ago = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ' + (s % 60) + 's'
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'
}

// Freshness colour for a "last activity" dot: green < 30s, amber < 2m, red beyond. Shared by StatusBadge's
// initial render and the live ticker that repaints it each second (lib/liveClock).
export const staleColor = (msSinceActivity: number): string =>
  msSinceActivity < 30000 ? '#3fb27f' : msSinceActivity < 120000 ? '#d99a2b' : '#e0564f'

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

export const prNumFromUrl = (url: string | null | undefined): string => (url ? url.split('/pull/')[1] || '' : '')
