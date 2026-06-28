import { spawnSync } from 'node:child_process'

const homes = new Map<string, string>()

// Shared ssh options. LogLevel=ERROR + UpdateHostKeys=no keep first-connection host-key chatter ("Warning:
// Permanently added…", the UpdateHostKeys "bad signature" probe) off the wire — on a fresh orchestrator host that
// hasn't seen the workers yet, those land on stderr and corrupt captured output (e.g. remoteHome's $HOME).
const SSH_OPTS = ['-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'LogLevel=ERROR', '-o', 'UpdateHostKeys=no']
const SCP_OPTS = ['-o', 'ConnectTimeout=20', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'LogLevel=ERROR', '-o', 'UpdateHostKeys=no']

// Run a command on a worker host. The host string is anything ssh accepts (e.g. an exe.dev VM, user@host).
export function sshExec(host: string, command: string, timeoutMs = 180_000): { ok: boolean; out: string } {
  const r = spawnSync('ssh', [...SSH_OPTS, host, command], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  return { ok: r.status === 0 && r.error == null, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

// Copy a local directory's CONTENTS into a remote directory (the remote dir must already exist).
export function scpInto(localDir: string, host: string, remoteDir: string): { ok: boolean; out: string } {
  const r = spawnSync('scp', ['-r', '-q', ...SCP_OPTS, `${localDir}/.`, `${host}:${remoteDir}/`], {
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
  const r = spawnSync('ssh', [...SSH_OPTS, host, 'printf %s "$HOME"'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 })
  const home = r.status === 0 && r.error == null ? (r.stdout ?? '').trim() : ''
  if (home) homes.set(host, home)
  return home
}

// Single-quote a path for safe interpolation into a remote shell command.
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
