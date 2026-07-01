export interface StatsTotals {
  tickets?: number
  events?: number
  deadlocks?: number
  caps?: number
}
export interface DailyRow {
  day: string
  dispatched?: number
  shipped?: number
  tokens?: number
  deadlocks?: number
  caps?: number
}
export interface ThreadRow {
  identifier: string
  outcome?: string | null
  tokens?: number
  cycle_ms?: number
  reworks?: number
  caps?: number
  deadlocks?: number
  account?: string | null
  thread_id?: string | null
}
export interface StatsData {
  totals: StatsTotals
  daily: DailyRow[]
  threads: ThreadRow[]
}

export type SortKey = 'tokens' | 'cycle_ms' | 'reworks' | 'caps'
