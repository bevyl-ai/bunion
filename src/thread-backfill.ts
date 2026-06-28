import { spawn } from 'node:child_process'
import type { Issue } from './types'

// Recover codex threads bunion has no record of — tickets that ran before thread-persistence shipped, or after a
// lost threads.json — by reading each worker's codex threads DB, keyed by the ticket's workspace directory. The
// newest match per ticket wins. Read-only and best-effort: a worker that's down or has no match is skipped. This
// is what makes a pre-persistence handoff chattable; it runs once, on the first board the daemon sees.

const QUERY_PY = `
import sqlite3, glob, os, json
dbs = sorted(glob.glob(os.path.expanduser('~/.codex/state_*.sqlite')))
out = {}
if dbs:
    try:
        con = sqlite3.connect('file:' + dbs[-1] + '?mode=ro', uri=True)
        for cwd, tid, upd in con.execute("SELECT cwd, id, updated_at FROM threads WHERE cwd LIKE '%/.bunion/workspaces/%' AND archived = 0 ORDER BY updated_at ASC"):
            out[os.path.basename(str(cwd).rstrip('/'))] = [tid, str(upd)]
    except Exception:
        pass
print(json.dumps(out))
`
const QUERY_CMD = `echo ${Buffer.from(QUERY_PY).toString('base64')} | base64 -d | python3`

function sshCaptureStdout(host: string, cmd: string): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn('ssh', ['-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', host, cmd], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    p.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
    })
    p.on('close', () => resolve(out))
    p.on('error', () => resolve(''))
  })
}

// For every board ticket `known` has no thread for, query each worker and return issue.id → { threadId, host }
// for the threads found (newest rollout per ticket).
export async function backfillThreads(board: Issue[], hosts: string[], known: (id: string) => boolean): Promise<Map<string, { threadId: string; host: string }>> {
  const missing = board.filter((i) => !known(i.id))
  if (missing.length === 0 || hosts.length === 0) return new Map()
  const wantedId = new Map(missing.map((i) => [i.identifier, i.id])) // workspace key (identifier) → linear id
  const newest = new Map<string, { threadId: string; host: string; upd: string }>()
  await Promise.all(
    hosts.map(async (host) => {
      let rows: Record<string, [string, string]>
      try {
        rows = JSON.parse((await sshCaptureStdout(host, QUERY_CMD)).trim() || '{}')
      } catch {
        return
      }
      for (const [ident, v] of Object.entries(rows)) {
        if (!wantedId.has(ident) || !Array.isArray(v)) continue
        const [tid, upd] = v
        const prev = newest.get(ident)
        if (typeof tid === 'string' && (!prev || String(upd) > prev.upd)) newest.set(ident, { threadId: tid, host, upd: String(upd) })
      }
    }),
  )
  const found = new Map<string, { threadId: string; host: string }>()
  for (const [ident, rec] of newest) {
    const id = wantedId.get(ident)
    if (id) found.set(id, { threadId: rec.threadId, host: rec.host })
  }
  return found
}
