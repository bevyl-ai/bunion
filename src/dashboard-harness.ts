// Local verification harness — NOT part of the app. Imports startDashboard with mock data resembling a
// real Snapshot, covering every interesting state called out in the migration spec. Run with:
//   bun src/dashboard-harness.ts
import { startDashboard, type Snapshot, type BoardItem, type RoleItem } from './dashboard'

const now = Date.now()
const DAY = 86400000

function tok(input: number, output: number, cached: number, phase: string) {
  return { phase, total: input + output, input, output, cached, reasoning: 0 }
}

function tokBreakdown(phases: ReturnType<typeof tok>[]) {
  return { total: phases.reduce((a, p) => a + p.total, 0), phases }
}

const items: BoardItem[] = [
  // running ticket, active <30s ago (green dot), with tokens
  {
    identifier: 'BEV-1001',
    title: 'Running ticket — green active dot, turn 5 activity ticking',
    state: 'In Progress',
    priority: 1,
    host: 'worker-1.exe.xyz',
    prUrl: null,
    url: 'https://linear.app/bevyl/issue/BEV-1001',
    note: null,
    status: 'running',
    enteredAt: now - 2 * 3600_000,
    endedAt: null,
    turn: 5,
    activity: 'Running the full unit test suite to confirm the fix does not regress adjacent coverage across the whole package before opening the PR',
    startedAt: now - 2 * 3600_000,
    lastActivity: now - 5000,
    retryAttempt: 0,
    retryDueAt: null,
    tokens: tokBreakdown([tok(120_000, 30_000, 90_000, 'plan'), tok(400_000, 120_000, 300_000, 'build')]),
  },
  // running ticket, active 60s ago (amber dot)
  {
    identifier: 'BEV-1002',
    title: 'Running ticket — amber active dot (60s ago)',
    state: 'In Progress',
    priority: 2,
    host: 'worker-2.exe.xyz',
    prUrl: 'https://github.com/bevyl-ai/bunion/pull/4231',
    url: 'https://linear.app/bevyl/issue/BEV-1002',
    note: null,
    status: 'running',
    enteredAt: now - 3600_000,
    endedAt: null,
    turn: 2,
    activity: 'Editing src/orchestrator.ts',
    startedAt: now - 3600_000,
    lastActivity: now - 60_000,
    retryAttempt: 0,
    retryDueAt: null,
    tokens: null,
  },
  // running ticket, active 200s ago (red dot)
  {
    identifier: 'BEV-1003',
    title: 'Running ticket — red stale active dot (200s ago)',
    state: 'In Progress',
    priority: 3,
    host: 'worker-3.exe.xyz',
    prUrl: null,
    url: 'https://linear.app/bevyl/issue/BEV-1003',
    note: null,
    status: 'running',
    enteredAt: now - 1800_000,
    endedAt: null,
    turn: 1,
    activity: 'Waiting on a slow CI run',
    startedAt: now - 1800_000,
    lastActivity: now - 200_000,
    retryAttempt: 0,
    retryDueAt: null,
    tokens: null,
  },
  // retrying with known retryDueAt
  {
    identifier: 'BEV-1004',
    title: 'Retrying ticket with a known retryDueAt',
    state: 'In Progress',
    priority: 4,
    host: 'worker-1.exe.xyz',
    prUrl: null,
    url: 'https://linear.app/bevyl/issue/BEV-1004',
    note: null,
    status: 'retrying',
    enteredAt: now - 500_000,
    endedAt: null,
    turn: 3,
    activity: '',
    startedAt: now - 500_000,
    lastActivity: now - 400_000,
    retryAttempt: 2,
    retryDueAt: now + 45_000,
    tokens: null,
  },
  // Needs Engineer, <1 day old — plain pink badge, no day count
  {
    identifier: 'BEV-2001',
    title: 'Needs Engineer, fresh (under 1 day)',
    state: 'Needs Engineer',
    priority: 2,
    host: 'worker-2.exe.xyz',
    prUrl: null,
    url: 'https://linear.app/bevyl/issue/BEV-2001',
    note: 'Token cap hit mid-build; needs a budget bump to continue.',
    status: 'handoff',
    enteredAt: now - 3 * 3600_000,
    endedAt: null,
    turn: 4,
    activity: '',
    startedAt: now - 3 * 3600_000,
    lastActivity: now - 3 * 3600_000,
    retryAttempt: 0,
    retryDueAt: null,
    tokens: tokBreakdown([tok(50_000, 10_000, 20_000, 'plan')]),
  },
  // Needs Engineer, 1-2 days — amber single-warning badge, no card pulse
  {
    identifier: 'BEV-2002',
    title: 'Needs Engineer, 1.5 days ignored — amber tier',
    state: 'Needs Engineer',
    priority: 1,
    host: null,
    prUrl: null,
    url: 'https://linear.app/bevyl/issue/BEV-2002',
    note: 'Ambiguous requirement — needs an engineer decision on which API to call.',
    status: 'handoff',
    enteredAt: now - 1.5 * DAY,
    endedAt: null,
    turn: 6,
    activity: '',
    startedAt: now - 1.5 * DAY,
    lastActivity: now - 1.5 * DAY,
    retryAttempt: 0,
    retryDueAt: null,
    tokens: null,
  },
  // Needs Engineer, 3+ days — hot-red pulsing badge + card border pulse
  {
    identifier: 'BEV-2003',
    title: 'Needs Engineer, 3.2 days ignored — hot-red pulsing tier',
    state: 'Needs Engineer',
    priority: 1,
    host: null,
    prUrl: null,
    url: 'https://linear.app/bevyl/issue/BEV-2003',
    note: 'Blocked on a decision about whether to break the public API.',
    status: 'handoff',
    enteredAt: now - 3.2 * DAY,
    endedAt: null,
    turn: 9,
    activity: '',
    startedAt: now - 3.2 * DAY,
    lastActivity: now - 3.2 * DAY,
    retryAttempt: 0,
    retryDueAt: null,
    tokens: null,
  },
  // STG - Ready to merge, <3 days — plain green, no day count
  {
    identifier: 'BEV-3001',
    title: 'Ready to merge, fresh (under 3 days)',
    state: 'STG - Ready to merge',
    priority: 3,
    host: null,
    prUrl: 'https://github.com/bevyl-ai/bunion/pull/4177',
    url: 'https://linear.app/bevyl/issue/BEV-3001',
    note: null,
    status: 'handoff',
    enteredAt: now - 1 * DAY,
    endedAt: null,
    turn: 3,
    activity: '',
    startedAt: now - 1 * DAY,
    lastActivity: now - 1 * DAY,
    retryAttempt: 0,
    retryDueAt: null,
    tokens: null,
  },
  // STG - Ready to merge, 3+ days — amber "ready - X.Xd waiting"
  {
    identifier: 'BEV-3002',
    title: 'Ready to merge, 4.1 days waiting — amber tier',
    state: 'STG - Ready to merge',
    priority: 2,
    host: null,
    prUrl: 'https://github.com/bevyl-ai/bunion/pull/4102',
    url: 'https://linear.app/bevyl/issue/BEV-3002',
    note: null,
    status: 'handoff',
    enteredAt: now - 4.1 * DAY,
    endedAt: null,
    turn: 3,
    activity: '',
    startedAt: now - 4.1 * DAY,
    lastActivity: now - 4.1 * DAY,
    retryAttempt: 0,
    retryDueAt: null,
    tokens: null,
  },
  // Ticket with tokens >= 1B — stale-token warning
  {
    identifier: 'BEV-4001',
    title: 'Historical ticket with corrupted (pre-fix) token accounting',
    state: 'Done',
    priority: null as unknown as number,
    host: null,
    prUrl: 'https://github.com/bevyl-ai/bunion/pull/3001',
    url: 'https://linear.app/bevyl/issue/BEV-4001',
    note: null,
    status: 'handoff',
    enteredAt: now - 10 * DAY,
    endedAt: now - 9 * DAY,
    turn: 12,
    activity: '',
    startedAt: now - 10 * DAY,
    lastActivity: now - 9 * DAY,
    retryAttempt: 0,
    retryDueAt: null,
    tokens: tokBreakdown([tok(600_000_000, 200_000_000, 150_000_000, 'plan'), tok(500_000_000, 200_000_000, 100_000_000, 'build')]),
  },
  // QA blocked with a note
  {
    identifier: 'BEV-5001',
    title: 'QA blocked with a note explaining why',
    state: 'QA blocked',
    priority: 2,
    host: 'worker-3.exe.xyz',
    prUrl: null,
    url: 'https://linear.app/bevyl/issue/BEV-5001',
    note: 'QA verdict: the new endpoint 500s when the payload omits `identifier`; needs a fix before it can ship.',
    status: 'handoff',
    enteredAt: now - 5 * 3600_000,
    endedAt: null,
    turn: 7,
    activity: '',
    startedAt: now - 5 * 3600_000,
    lastActivity: now - 5 * 3600_000,
    retryAttempt: 0,
    retryDueAt: null,
    tokens: tokBreakdown([tok(80_000, 20_000, 10_000, 'plan'), tok(150_000, 50_000, 30_000, 'build'), tok(40_000, 15_000, 5_000, 'qa')]),
  },
  // A ticket in an unmapped/renamed state
  {
    identifier: 'BEV-6001',
    title: 'Ticket sitting in a renamed Linear state not in any column',
    state: 'Awaiting Design Review',
    priority: 3,
    host: null,
    prUrl: null,
    url: 'https://linear.app/bevyl/issue/BEV-6001',
    note: null,
    status: 'handoff',
    enteredAt: now - 6 * 3600_000,
    endedAt: null,
    turn: 1,
    activity: '',
    startedAt: now - 6 * 3600_000,
    lastActivity: now - 6 * 3600_000,
    retryAttempt: 0,
    retryDueAt: null,
    tokens: null,
  },
  // queued ticket
  {
    identifier: 'BEV-7001',
    title: 'Queued candidate — no free slot yet',
    state: 'Todo',
    priority: 4,
    host: null,
    prUrl: null,
    url: 'https://linear.app/bevyl/issue/BEV-7001',
    note: null,
    status: 'queued',
    enteredAt: now - 1200_000,
    endedAt: null,
    turn: 0,
    activity: '',
    startedAt: 0,
    lastActivity: 0,
    retryAttempt: 0,
    retryDueAt: null,
    tokens: null,
  },
]

const roles: RoleItem[] = [
  {
    name: 'mechanic',
    status: 'running',
    activity: 'Running the CI-health sweep across recent merges to main',
    model: 'gpt-5.5-codex',
    host: 'worker-4.exe.xyz',
    tokens: 12_500_000,
    cadenceMs: 3600_000,
    lastRunAt: now - 3600_000,
    filedToday: 2,
    maxPerDay: 5,
    granted: 0,
    paused: false,
  },
  {
    name: 'dreamer',
    status: 'idle',
    activity: '',
    model: 'gpt-5.5',
    host: null,
    tokens: 4_200_000,
    cadenceMs: 4 * 3600_000,
    lastRunAt: now - 5 * 3600_000,
    filedToday: 1,
    maxPerDay: 2,
    granted: 1,
    paused: false,
  },
  {
    name: 'user-advocate',
    status: 'idle',
    activity: '',
    model: null,
    host: 'worker-5.exe.xyz',
    tokens: 0,
    cadenceMs: 8 * 3600_000,
    lastRunAt: null,
    filedToday: 0,
    maxPerDay: null,
    granted: 0,
    paused: true, // paused role
  },
]

const snapshot: Snapshot = {
  scope: 'bevyl-ai/bunion',
  cap: 6,
  items,
  totalTokens: items.reduce((a, i) => a + (i.tokens?.total ?? 0), 0),
  totalInput: 1_450_000_000,
  totalOutput: 620_000_000,
  totalCached: 350_000_000,
  paused: false,
  rateLimits: { usedPercent: 82, resetsInSeconds: 1800, raw: {}, at: now },
  secondsRunning: 3 * 3600 + 22 * 60,
  roles,
  columns: [
    { name: 'Planning', c: '#8b93a1', states: ['Triage', 'Backlog', 'Todo'] },
    { name: 'In Progress', c: '#5b8def', states: ['In Progress'] },
    { name: 'QA Requested', c: '#d9a441', states: ['QA Requested'], inert: true },
    { name: 'QA check', c: '#d99a2b', states: ['QA Testing'] },
    { name: 'Verify QA', c: '#c79a3a', states: ['QA Verify'] },
    { name: 'Blocked', c: '#e0564f', states: ['QA blocked'] },
    { name: 'Needs Engineer', c: '#d9568c', states: ['Needs Engineer'], inert: true },
    { name: 'Ready', c: '#3fb27f', states: ['STG - Ready to merge'], inert: true },
    { name: 'In Staging', c: '#e3b341', states: ['STG - Merged'], inert: true },
    { name: 'Verifying prod', c: '#4a9eda', states: ['Verifying in Prod'] },
    { name: 'Done', c: '#6b7280', states: ['Done'], inert: true },
  ],
  terminalStates: ['Done', 'Canceled', 'Duplicate'],
  gatewayAccounts: ['acct-a ×3', 'acct-b ×2'],
  pollHealth: { failureStreak: 4, lastError: 'ETIMEDOUT contacting api.linear.app', lastOkAt: now - 900_000 },
}

// per-ticket transcript logs
const logs = new Map<string, string[]>()
logs.set('BEV-1001', [
  '── turn 1 ──',
  '○ operator: please add a caching layer',
  '● Sure, I will start by reading the existing service.',
  '$ bun test src/service.test.ts',
  '⚙ tool: read_file src/service.ts',
  '✎ edited src/service.ts',
  '── turn 2 ──',
  '● Added the cache and reran the suite; all green.',
])
logs.set('BEV-2003', ['── turn 1 ──', '● Investigated; this needs a product decision on the public API shape.'])
let livePartial = ''

const getSnapshot = () => snapshot
const getLog = (id: string) => logs.get(id) ?? []
const getLive = (id: string) => (id === 'BEV-1001' ? livePartial : '')

function log(m: string) {
  console.log(m)
}

async function onAction(id: string, action: string) {
  console.log(`[action] ${id} ${action}`)
  if (id === '__pause__' && action === 'toggle') {
    snapshot.paused = !snapshot.paused
    return { ok: true, msg: snapshot.paused ? 'paused' : 'resumed' }
  }
  if (action === 'pause') {
    const r = snapshot.roles.find((x) => x.name === id)
    if (r) { r.paused = !r.paused; return { ok: true, msg: r.paused ? 'paused' : 'resumed' } }
  }
  if (action === 'run') return { ok: true, msg: 'queued a run' }
  if (action === 'grant') return { ok: true, msg: 'granted' }
  if (action.startsWith('move:')) {
    const to = action.slice(5)
    const item = snapshot.items.find((i) => i.identifier === id)
    if (item) {
      // simulate a FAILING move for BEV-9999-fail sentinel to test optimistic revert
      if (id === 'FAIL-ME') return { ok: false, msg: 'simulated failure' }
      item.state = to
      return { ok: true, msg: `moved to ${to}` }
    }
  }
  if (action === 'restart') return { ok: true, msg: 'restarted' }
  if (action === 'bump') return { ok: true, msg: 'budget bumped' }
  if (action === 'cancel') {
    // Real orchestrator moves to Canceled, which fetchBoard excludes → gone next snapshot. Mimic that by dropping it.
    const idx = snapshot.items.findIndex((i) => i.identifier === id)
    if (idx >= 0) snapshot.items.splice(idx, 1)
    return { ok: true, msg: 'canceled — moved to Canceled' }
  }
  return { ok: true, msg: 'done' }
}

async function onChat(id: string, text: string) {
  console.log(`[chat] ${id}: ${text}`)
  const arr = logs.get(id) ?? []
  arr.push(`○ ${text}`)
  logs.set(id, arr)
  setTimeout(() => {
    const a = logs.get(id) ?? []
    a.push(`● Got it — acknowledged: "${text}"`)
    logs.set(id, a)
  }, 800)
  return { ok: true, reply: 'queued' }
}

const stats = {
  totals: () => ({ tickets: 42, events: 918, deadlocks: 3, caps: 7 }),
  daily: (n: number) =>
    Array.from({ length: Math.min(n, 10) }, (_, i) => ({
      day: new Date(now - i * DAY).toISOString().slice(0, 10),
      dispatched: 5 - (i % 3),
      shipped: 3 - (i % 2),
      tokens: 50_000_000 * (i + 1),
      deadlocks: i === 2 ? 1 : 0,
      caps: i === 4 ? 2 : 0,
    })),
  threads: (_kind: string, n: number) =>
    items.slice(0, Math.min(n, items.length)).map((it, i) => ({
      identifier: it.identifier,
      outcome: it.state,
      tokens: it.tokens?.total ?? 1_000_000 * (i + 1),
      cycle_ms: 3600_000 * (i + 1),
      reworks: i % 3,
      caps: i === 1 ? 1 : 0,
      deadlocks: i === 3 ? 1 : 0,
      account: 'acct-a shared-pool',
      thread_id: `thread_${it.identifier.toLowerCase()}_abcdef123456`,
    })),
}

const PORT = Number(process.argv[2] ?? 4390)
startDashboard(PORT, getSnapshot, getLog, log, onAction, onChat, stats as never, getLive)
console.log(`harness listening on http://localhost:${PORT}`)
