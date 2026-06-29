import { execAsync, shq } from '../ssh'
import type { AgentEvent, DynamicTool } from '../types'

// The `wait` host tool. The agent calls it ONCE to wait for something async (CI checks, a review to land, a deploy);
// the orchestrator polls host-side on the worker — in plain code, spending ZERO agent tokens — and returns a concise
// result. This replaces the costly poll-and-reason loop (the agent looping `gh pr checks` + `sleep`, reasoning "still
// pending" between every check). A tool call blocks the turn without generating tokens, and the wait is bounded well
// under the turn timeout, so a long wait is free + safe.

const DESCRIPTION =
  'Wait for something async to finish WITHOUT spending tokens — the host polls for you on your worker and returns when ' +
  'it resolves. ALWAYS use this instead of looping `gh pr checks` / `gh api …` + `sleep` by hand. Two modes:\n' +
  '• { for: "checks", pr? } — block until the PR\'s CI checks finish; returns pass/fail + the failing checks (omit `pr` to use the current branch).\n' +
  '• { for: "command", command, until?, pattern? } — poll a shell command (run in your workspace) until it succeeds: ' +
  'until="exit_zero" (default) or until="stdout_matches" with a `pattern` regex the stdout must contain. Use this to wait ' +
  'for a code review to appear, a preview deploy to come up, etc.\n' +
  'Optional: interval_seconds (default 20), timeout_seconds (default 1200, max 1800). You are charged ZERO tokens while it waits.'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['for'],
  properties: {
    for: { enum: ['checks', 'command'], description: '"checks" waits for a PR\'s CI to finish; "command" polls a shell command until it succeeds.' },
    pr: { type: ['string', 'number'], description: '(checks) PR number or branch; omit to use the workspace\'s current branch.' },
    command: { type: 'string', description: '(command) shell command to poll, run in your workspace.' },
    until: { enum: ['exit_zero', 'stdout_matches'], description: '(command) success = the command exits 0 (default) or its stdout matches `pattern`.' },
    pattern: { type: 'string', description: '(command, until=stdout_matches) a regex the command stdout must contain to count as done.' },
    interval_seconds: { type: 'number', description: 'seconds between polls (default 20).' },
    timeout_seconds: { type: 'number', description: 'give up after this many seconds (default 1200, max 1800).' },
  },
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const tail = (s: string, n: number): string => (s.length > n ? '…' + s.slice(-n) : s)
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const fail = (message: string): { success: false; output: string } => ({ success: false, output: JSON.stringify({ error: { message } }) })

export function waitTool(host: string | null, workspace: string, onEvent: (e: AgentEvent) => void = () => {}): DynamicTool {
  return {
    spec: { name: 'wait', description: DESCRIPTION, inputSchema: SCHEMA },
    async run(args: unknown): Promise<{ success: boolean; output: string }> {
      const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
      const mode = a.for
      const interval = clamp(typeof a.interval_seconds === 'number' ? a.interval_seconds : 20, 5, 120)
      const timeout = clamp(typeof a.timeout_seconds === 'number' ? a.timeout_seconds : 1200, 30, 1800)
      // Source ~/.profile so the worker's agent env is present — notably GH_HOST, which gh needs to find its auth in
      // ~/.config/gh/hosts.yml (codex itself runs via a login shell for the same reason). Without it, gh hits github.com unauthed.
      const cd = `. ~/.profile 2>/dev/null; cd ${shq(workspace)} && `

      if (mode === 'checks') {
        const ref = a.pr != null && a.pr !== '' ? ` ${shq(String(a.pr))}` : ''
        onEvent({ label: 'waiting', log: `⏳ wait: CI checks${a.pr != null && a.pr !== '' ? ` (${String(a.pr)})` : ''} — token-free` })
        // gh pr checks --watch blocks until every check finishes (handles "not registered yet" + pending→done); wrap in
        // `timeout` so it can't outrun our budget. exit: 0=all pass, 8=some failed, 124=timed out. Capture the table
        // (2>&1) — older gh has no `--json` on this subcommand, so the printed table IS the structured result.
        const w = await execAsync(host, `${cd}timeout ${timeout} gh pr checks${ref} --watch --interval ${interval} 2>&1; echo "__exit=$?"`, (timeout + 30) * 1000)
        const exit = parseInt((w.out.match(/__exit=(\d+)/) ?? [])[1] ?? '1', 10)
        const table = w.out.replace(/\s*__exit=\d+\s*$/, '').trim()
        const verdict = exit === 0 ? 'all checks GREEN ✅' : exit === 8 ? 'checks FAILED ❌ — see the failing check below, then `gh run view <id> --log-failed` for the error' : exit === 124 ? 'still PENDING (hit the wait timeout) ⏱' : `could not read checks (gh exit ${exit})`
        return { success: exit === 0, output: `CI: ${verdict}\n${tail(table, 2500)}` }
      }

      if (mode === 'command') {
        const command = typeof a.command === 'string' ? a.command.trim() : ''
        if (!command) return fail('missing `command`')
        const until = a.until === 'stdout_matches' ? 'stdout_matches' : 'exit_zero'
        let re: RegExp | null = null
        if (until === 'stdout_matches') {
          try {
            re = new RegExp(String(a.pattern ?? ''))
          } catch {
            return fail('invalid `pattern` regex')
          }
        }
        const deadline = Date.now() + timeout * 1000
        let polls = 0
        onEvent({ label: 'waiting', log: `⏳ wait: polling \`${tail(command, 60)}\` — token-free` })
        for (;;) {
          polls++
          const r = await execAsync(host, `${cd}${command}`, Math.min(60_000, timeout * 1000))
          const met = until === 'stdout_matches' ? (re ? re.test(r.out) : false) : r.ok
          if (met) return { success: true, output: `condition met after ${polls} poll(s):\n${tail(r.out.trim(), 3000)}` }
          if (Date.now() >= deadline) return { success: false, output: `timed out (${timeout}s, ${polls} polls) — condition never met. last output:\n${tail(r.out.trim(), 3000)}` }
          await sleep(interval * 1000)
        }
      }

      return fail('`for` must be "checks" or "command"')
    },
  }
}
