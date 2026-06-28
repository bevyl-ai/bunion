import { spawnSync } from 'node:child_process'

const homes = new Map<string, string>()

export function sshOptions(opts: { connectTimeoutSeconds?: number; serverAliveIntervalSeconds?: number } = {}): string[] {
  const trustOnFirstUse = process.env.BUNION_SSH_TRUST_ON_FIRST_USE === '1'
  const out = [
    '-o',
    `ConnectTimeout=${opts.connectTimeoutSeconds ?? 20}`,
    '-o',
    'BatchMode=yes',
    '-o',
    `StrictHostKeyChecking=${trustOnFirstUse ? 'accept-new' : 'yes'}`,
    '-o',
    'LogLevel=ERROR',
    '-o',
    `UpdateHostKeys=${trustOnFirstUse ? 'no' : 'yes'}`,
  ]
  if (opts.serverAliveIntervalSeconds) out.splice(4, 0, '-o', `ServerAliveInterval=${opts.serverAliveIntervalSeconds}`)
  return out
}

function scpOptions(): string[] {
  return sshOptions({ connectTimeoutSeconds: 20 }).filter((v) => !v.startsWith('ServerAliveInterval='))
}

// Run a command on a worker host. The host string is anything ssh accepts (e.g. an exe.dev VM, user@host).
export function sshExec(host: string, command: string, timeoutMs = 180_000): { ok: boolean; out: string } {
  const r = spawnSync('ssh', [...sshOptions({ connectTimeoutSeconds: 20, serverAliveIntervalSeconds: 15 }), host, command], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  return { ok: r.status === 0 && r.error == null, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

// Copy a local directory's CONTENTS into a remote directory (the remote dir must already exist).
export function scpInto(localDir: string, host: string, remoteDir: string): { ok: boolean; out: string } {
  const r = spawnSync('scp', ['-r', '-q', ...scpOptions(), `${localDir}/.`, `${host}:${remoteDir}/`], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return { ok: r.status === 0 && r.error == null, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

// The host's absolute $HOME (cached) — needed for absolute workspace paths the codex cwd param requires. Reads
// STDOUT ONLY: an ssh diagnostic on stderr must never end up concatenated into the path (it did, on a fresh
// orchestrator host: `/home/exedevWarning: Permanently added…` → mkdir Permission denied).
export function remoteHome(host: string): string {
  const cached = homes.get(host)
  if (cached) return cached
  const r = spawnSync('ssh', [...sshOptions({ connectTimeoutSeconds: 20, serverAliveIntervalSeconds: 15 }), host, 'printf %s "$HOME"'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 })
  const home = r.status === 0 && r.error == null ? (r.stdout ?? '').trim() : ''
  if (home) homes.set(host, home)
  return home
}

// Single-quote a path for safe interpolation into a remote shell command.
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
