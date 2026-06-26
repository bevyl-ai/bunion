export function log(message: string): void {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  console.log(`${ts} ${message}`)
}

export function warn(message: string): void {
  log(`WARN ${message}`)
}
