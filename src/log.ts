// In-memory ring of recent log lines, so the brain can hand the pool roles its OWN operational state (errors,
// deadlocks, rate-limit/auth warnings) — a worker VM can't read the daemon log otherwise.
const RING: string[] = []
export function log(message: string): void {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const line = `${ts} ${message}`
  console.log(line)
  RING.push(line)
  if (RING.length > 400) RING.shift()
}
export function recentLogs(): readonly string[] {
  return RING
}

export function warn(message: string): void {
  log(`WARN ${message}`)
}
