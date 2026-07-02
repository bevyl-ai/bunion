import { githubAppToken } from '../github'
import type { GithubMirror } from '../github-mirror'
import { type CiState, gateFromSnapshot, refreshPr, type ReviewState, STUPIFY_LOGIN } from '../github-sync'
import { execAsync, shq } from '../ssh'
import type { AgentEvent, Config, DynamicTool } from '../types'

// The `wait` host tool. The agent calls it ONCE and the orchestrator polls host-side on the worker — in plain code,
// spending ZERO agent tokens — then returns a concise result. This replaces the poll-and-reason burn (agents looping
// `gh pr checks` + `gh api …/reviews` + `sleep`, reasoning "still pending" between every check).
//
// DEFAULT = the build gate: one call waits for BOTH the PR's CI checks AND stupify's code review, and returns a single
// actionable verdict (PASS / CI_FAILED / CHANGES_REQUESTED / STUPIFY_FLAKED / PENDING) — so the agent never hand-rolls
// the stupify sha-matching dance. Escape hatch: pass `command` to poll any worker command until it resolves.

const DESCRIPTION =
  "Wait — token-free — for your PR's build gate to resolve: CI checks AND stupify's code review, in ONE call. After you " +
  'push, just call `wait` (optionally { pr }); it returns one verdict — act on it:\n' +
  '• PASS — CI green + stupify approved (✅) the latest code → move to QA Testing.\n' +
  '• CI_FAILED — lists the failing checks → fix them, push again (a push re-triggers CI + stupify).\n' +
  '• CHANGES_REQUESTED — stupify objected to the latest code (its words are included) → fix it in code (or push back inline with justification), push, then `wait` again.\n' +
  '• STUPIFY_FLAKED — CI green but stupify never reviewed within the timeout → proceed to QA, noting in the workpad you proceeded without a `✅` (reviewer unavailable).\n' +
  '• PENDING — CI still running past the timeout → investigate.\n' +
  'It handles the stupify sha-matching ([skip ci] commits, stale ✅ vs a real re-review) for you. ' +
  'Escape hatch for other waits (a deploy, a custom condition): { command, until: "exit_zero"|"stdout_matches", pattern }. ' +
  'interval_seconds (def 20), timeout_seconds (def 1200, max 1800). You are charged ZERO tokens while it waits.'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pr: { type: ['string', 'number'], description: 'PR number or branch for the build gate; omit to use the workspace\'s current branch.' },
    command: { type: 'string', description: 'Escape hatch: a shell command to poll in your workspace instead of the build gate.' },
    until: { enum: ['exit_zero', 'stdout_matches'], description: '(command) success = exits 0 (default) or stdout matches `pattern`.' },
    pattern: { type: 'string', description: '(command, until=stdout_matches) a regex the stdout must contain.' },
    interval_seconds: { type: 'number', description: 'seconds between polls (default 20).' },
    timeout_seconds: { type: 'number', description: 'give up after this many seconds (default 1200, max 1800).' },
  },
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const tail = (s: string, n: number): string => (s.length > n ? '…' + s.slice(-n) : s)
const short = (s: string): string => (s || '').slice(0, 7)
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const fail = (message: string): { success: false; output: string } => ({ success: false, output: JSON.stringify({ error: { message } }) })

// `gh pr checks` prints `<name>\t<status>\t<duration>\t<link>`; older gh has no --json on it, so parse the table.
function parseChecks(out: string): CiState {
  let pending = 0, failed = 0, passed = 0
  const failures: string[] = []
  for (const line of out.split('\n')) {
    const f = line.split('\t')
    if (f.length < 2 || !f[0]!.trim()) continue
    const status = (f[1] || '').trim().toLowerCase()
    if (status === 'pass') passed++
    else if (status === 'fail' || status === 'cancel') { failed++; failures.push(`${f[0]!.trim()}${f[3] ? ` ${f[3].trim()}` : ''}`) }
    else if (status === 'pending' || status === '') pending++
    // skipping / neutral → ignore
  }
  return { pending, failed, passed, failures, any: pending + failed + passed > 0 }
}

// Parse `gh pr view --json headRefOid,commits,reviews`: find stupify's review that covers the latest CODE commit
// (head, or the newest non-`[skip ci]`/reset commit), and whether it approved (`✅`).
function parseReview(json: string): ReviewState {
  const empty: ReviewState = { reviewed: false, approved: false, body: '', sha: '', head: '', codeSha: '' }
  let d: { headRefOid?: string; commits?: { oid?: string; messageHeadline?: string }[]; reviews?: { author?: { login?: string }; body?: string }[] }
  try {
    d = JSON.parse(json)
  } catch {
    return empty
  }
  const head = String(d.headRefOid || '')
  const commits = Array.isArray(d.commits) ? d.commits : []
  let codeSha = head
  for (let i = commits.length - 1; i >= 0; i--) {
    if (!/\[skip ci\]|chore\(pr\):\s*reset/i.test(String(commits[i]!.messageHeadline || ''))) {
      codeSha = String(commits[i]!.oid || head)
      break
    }
  }
  const covers = (sha: string): boolean => !!sha && (sha === head || sha === codeSha || head.startsWith(sha) || codeSha.startsWith(sha))
  let cover: { body: string; sha: string } | null = null
  for (const r of Array.isArray(d.reviews) ? d.reviews : []) {
    if (!String(r.author?.login || '').includes(STUPIFY_LOGIN)) continue
    const sha = (String(r.body || '').match(/stupify:([0-9a-f]{7,40})/) || [])[1] || ''
    if (covers(sha)) cover = { body: String(r.body || ''), sha } // chronological → last match wins (latest review of the head code)
  }
  if (!cover) return { ...empty, head, codeSha }
  return { reviewed: true, approved: cover.body.includes('✅'), body: cover.body.replace(/<!--[\s\S]*?-->/g, '').trim(), sha: cover.sha, head, codeSha }
}

export function waitTool(cfg: Config, host: string | null, workspace: string, repo: string, ghMirror: GithubMirror, onEvent: (e: AgentEvent) => void = () => {}): DynamicTool {
  return {
    spec: { name: 'wait', description: DESCRIPTION, inputSchema: SCHEMA },
    async run(args: unknown): Promise<{ success: boolean; output: string }> {
      const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
      const interval = clamp(typeof a.interval_seconds === 'number' ? a.interval_seconds : 20, 5, 120)
      const timeout = clamp(typeof a.timeout_seconds === 'number' ? a.timeout_seconds : 1200, 30, 1800)
      // Source ~/.profile so the worker's agent env is present. With a github app configured, prepend a fresh
      // installation token as GH_TOKEN so `gh` authenticates as the factory bot against github.com — the same identity
      // the agent session uses. (vm-setup drops GH_HOST so gh defaults to github.com; without a token it'd be unauthed.)
      const ghToken = cfg.github ? await githubAppToken(cfg) : null
      const prefix = ghToken ? `export GH_TOKEN=${shq(ghToken)}; ` : ''
      const sh = (cmd: string): Promise<{ ok: boolean; out: string; code: number | null }> => execAsync(host, `${prefix}. ~/.profile 2>/dev/null; cd ${shq(workspace)} && ${cmd}`, Math.min(90_000, timeout * 1000))
      const deadline = Date.now() + timeout * 1000

      // ESCAPE HATCH — poll an arbitrary command.
      if (typeof a.command === 'string' && a.command.trim()) {
        const command = a.command.trim()
        const until = a.until === 'stdout_matches' ? 'stdout_matches' : 'exit_zero'
        let re: RegExp | null = null
        if (until === 'stdout_matches') {
          try {
            re = new RegExp(String(a.pattern ?? ''))
          } catch {
            return fail('invalid `pattern` regex')
          }
        }
        let polls = 0
        onEvent({ label: 'waiting', log: `⏳ wait: polling \`${tail(command, 60)}\` — token-free` })
        for (;;) {
          polls++
          const r = await sh(command)
          const met = until === 'stdout_matches' ? (re ? re.test(r.out) : false) : r.ok
          if (met) return { success: true, output: `condition met after ${polls} poll(s):\n${tail(r.out.trim(), 3000)}` }
          if (Date.now() >= deadline) return { success: false, output: `timed out (${timeout}s, ${polls} polls) — condition never met. last output:\n${tail(r.out.trim(), 3000)}` }
          await sleep(interval * 1000)
        }
      }

      // DEFAULT — the build gate. Served from the brain's GitHub mirror when the factory app can see the repo
      // (one debounced GraphQL request per interval, shared across concurrent waiters, zero VM traffic); the
      // legacy VM-side `gh` polling remains for repos outside the app installation (e.g. the Octember org).
      onEvent({ label: 'waiting', log: `⏳ wait: build gate (CI + stupify)${a.pr != null && a.pr !== '' ? ` ${String(a.pr)}` : ''} — token-free` })
      const number = await resolvePrNumber(a.pr, sh)
      if (number === null) return fail('no PR found for this branch — open/push the PR first')
      if (typeof number === 'string') return fail(number)

      if (cfg.github) {
        let polls = 0
        for (;;) {
          polls++
          let snap
          try {
            snap = await refreshPr(cfg, ghMirror, repo, number, Math.max(5_000, (interval * 1000) / 2))
          } catch {
            break // transient GitHub API failure — the legacy VM gate below is the resilient path, not a hard fail
          }
          if (snap === 'not_found') return fail(`PR #${number} not found in ${repo}`)
          if (snap === 'no_access') break // app not installed on this repo → legacy VM gate below
          const g = gateFromSnapshot(snap)
          if (g.ci.failed > 0) return verdict('CI_FAILED', g.ci, g.review, polls)
          if (g.review.reviewed && !g.review.approved) return verdict('CHANGES_REQUESTED', g.ci, g.review, polls)
          if (g.ci.any && g.ci.pending === 0 && g.review.reviewed && g.review.approved) return verdict('PASS', g.ci, g.review, polls)
          if (Date.now() >= deadline) return verdict(g.ci.pending > 0 || !g.ci.any ? 'PENDING' : 'STUPIFY_FLAKED', g.ci, g.review, polls)
          await sleep(interval * 1000)
        }
      }

      // LEGACY gate — VM-side `gh` polling, for setups with no app / repos the app cannot see.
      const ref = ` ${shq(String(number))}`
      let ci: CiState = { pending: 1, failed: 0, passed: 0, failures: [], any: false }
      let rv: ReviewState = { reviewed: false, approved: false, body: '', sha: '', head: '', codeSha: '' }
      let polls = 0
      for (;;) {
        polls++
        const c = await sh(`gh pr checks${ref} 2>&1`)
        ci = parseChecks(c.out)
        if (ci.failed > 0) return verdict('CI_FAILED', ci, rv, polls)
        const v = await sh(`gh pr view${ref} --json headRefOid,commits,reviews 2>&1`)
        rv = parseReview(v.out)
        if (rv.reviewed && !rv.approved) return verdict('CHANGES_REQUESTED', ci, rv, polls)
        if (ci.any && ci.pending === 0 && rv.reviewed && rv.approved) return verdict('PASS', ci, rv, polls)
        if (Date.now() >= deadline) break
        await sleep(interval * 1000)
      }
      // Timed out: CI still pending → PENDING; CI settled but stupify never reviewed → FLAKED (proceed).
      return verdict(ci.pending > 0 || !ci.any ? 'PENDING' : 'STUPIFY_FLAKED', ci, rv, polls)
    },
  }
}

// The gate needs a concrete PR number for the mirror. A numeric `pr` is used as-is; a branch name (or nothing —
// the workspace's current branch) resolves with ONE `gh pr view` on the worker. Returns the number, null when no
// PR exists, or an error string for other gh failures.
async function resolvePrNumber(pr: unknown, sh: (cmd: string) => Promise<{ ok: boolean; out: string; code: number | null }>): Promise<number | null | string> {
  if (typeof pr === 'number' && Number.isInteger(pr) && pr > 0) return pr
  if (typeof pr === 'string' && /^\d+$/.test(pr.trim())) return Number(pr.trim())
  const ref = typeof pr === 'string' && pr.trim() ? ` ${shq(pr.trim())}` : ''
  const r = await sh(`gh pr view${ref} --json number 2>&1`)
  if (/no pull requests found|no git remote|not a git repository/i.test(r.out)) return null
  try {
    const n = (JSON.parse(r.out) as { number?: number }).number
    return typeof n === 'number' ? n : `could not resolve the PR number (gh said: ${tail(r.out.trim(), 200)})`
  } catch {
    return `could not resolve the PR number (gh said: ${tail(r.out.trim(), 200)})`
  }
}

function verdict(kind: string, ci: CiState, rv: ReviewState, polls: number): { success: boolean; output: string } {
  const ciLine = ci.failed > 0 ? `FAILED ❌ (${ci.failed} failing${ci.failures.length ? `: ${ci.failures.join('; ')}` : ''})` : !ci.any ? 'no checks reported' : ci.pending > 0 ? `pending (${ci.pending} still running, ${ci.passed} passed)` : `green ✅ (${ci.passed} checks)`
  const stLine = rv.reviewed ? `${rv.approved ? 'approved ✅' : 'CHANGES REQUESTED'} (reviewed ${short(rv.sha)}, head ${short(rv.head)})` : 'no review of the latest code yet'
  const rec: Record<string, string> = {
    PASS: 'Gate passed → move to QA Testing.',
    CI_FAILED: 'Fix the failing checks, then push (a push re-triggers CI + stupify).',
    CHANGES_REQUESTED: 'Address stupify\'s objection in code (or push back inline with justification), push, then `wait` again.',
    STUPIFY_FLAKED: 'Stupify did not review in time and CI is green → proceed to QA, noting in the workpad you proceeded without a `✅` (reviewer unavailable).',
    PENDING: 'CI is still pending past the wait window — investigate (a check may be stuck).',
  }
  const detail = kind === 'CHANGES_REQUESTED' && rv.body ? `\nstupify said: ${rv.body.slice(0, 500)}` : ''
  return { success: kind === 'PASS', output: `BUILD GATE: ${kind} (after ${polls} poll(s))\nCI: ${ciLine}\nstupify: ${stLine}${detail}\n→ ${rec[kind] ?? ''}` }
}
