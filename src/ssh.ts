import { spawnSync } from 'node:child_process'

const homes = new Map<string, string>()

// Run a command on a worker host. The host string is anything ssh accepts (e.g. an exe.dev VM, user@host).
export function sshExec(host: string, command: string, timeoutMs = 180_000): { ok: boolean; out: string } {
  const r = spawnSync('ssh', ['-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', host, command], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  return { ok: r.status === 0 && r.error == null, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

// Copy a local directory's CONTENTS into a remote directory (the remote dir must already exist).
export function scpInto(localDir: string, host: string, remoteDir: string): { ok: boolean; out: string } {
  const r = spawnSync('scp', ['-r', '-q', '-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', `${localDir}/.`, `${host}:${remoteDir}/`], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return { ok: r.status === 0 && r.error == null, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

// The host's absolute $HOME (cached) — needed for absolute workspace paths the codex cwd param requires.
export function remoteHome(host: string): string {
  const cached = homes.get(host)
  if (cached) return cached
  const r = sshExec(host, 'printf %s "$HOME"', 30_000)
  const home = r.ok ? r.out.trim() : ''
  if (home) homes.set(host, home)
  return home
}

// Single-quote a path for safe interpolation into a remote shell command.
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
