import tailwindPlugin from 'bun-plugin-tailwind'
import type { RateLimits } from './types'
import type { TokenBreakdown } from './tokens'
import type { Stats } from './stats'
import boardHtml from './dashboard-client/board.html'
import statsHtml from './dashboard-client/stats.html'

// bun-plugin-tailwind only implements the Bun.build() bundler-plugin hooks (onBeforeParse), not the
// Bun.plugin() module-loader hooks that Bun.serve's automatic HTML-import bundling uses -- registering it via
// Bun.plugin() throws ("build.onBeforeParse is not a function"). So the two page stylesheets are compiled
// explicitly via Bun.build() once at process start (still no separate operator-run build step -- it just
// happens automatically every time the process boots) and served from memory below.
async function compileTailwindCss(entrypoint: string): Promise<string> {
  const result = await Bun.build({ entrypoints: [entrypoint], plugins: [tailwindPlugin] })
  const out = result.outputs.find((o) => o.path.endsWith('.css'))
  if (!out) throw new Error(`tailwind build produced no CSS output for ${entrypoint}`)
  return out.text()
}

// One ticket on the board. `status`: running (an agent is on it now), retrying (waiting out a backoff/continuation),
// or queued (an eligible candidate with no free slot/VM yet). The run-specific fields are 0/empty unless running.
export interface BoardItem {
  identifier: string
  title: string
  state: string
  priority: number
  host: string | null
  prUrl: string | null
  url: string // the Linear issue URL — the full workpad/notes are one click away
  note: string | null // the agent's last message (e.g. a QA verdict) — surfaces the human action when there's no live log
  status: 'running' | 'retrying' | 'queued' | 'handoff' // handoff = left the active states (e.g. in QA), bunion is done with it for now
  enteredAt: number | null // ms — Linear startedAt; the clock for total elapsed in the factory
  endedAt: number | null // ms — Linear completedAt; freezes total elapsed once merged/Done
  turn: number
  activity: string
  startedAt: number
  lastActivity: number
  retryAttempt: number
  retryDueAt: number | null
  tokens: TokenBreakdown | null // cumulative token use, per pipeline stage
}

// One pool role in the bottom dock — an always-on ambient agent (mechanic, dreamer, …) on a cadence.
export interface RoleItem {
  name: string
  status: 'running' | 'idle'
  activity: string
  model: string | null
  host: string | null
  tokens: number
  cadenceMs: number
  lastRunAt: number | null
  filedToday: number
  maxPerDay: number | null
  granted: number // operator top-up granted for today (adds to maxPerDay)
  paused: boolean // operator paused THIS role (independent of the global factory pause)
}

export interface Snapshot {
  scope: string
  cap: number
  items: BoardItem[] // the WHOLE board (every active+labeled ticket), not just the running ones
  totalTokens: number // all-time tokens across every tracked ticket
  totalInput: number
  totalOutput: number
  totalCached: number // cache-hit input tokens — the cheap part; cached/input is the hit rate
  paused: boolean // operator panic switch — when true, dispatch is halted (daemon + dashboard stay up)
  rateLimits: RateLimits | null // latest coding-agent rate-limit snapshot (Symphony §13.3), null until codex reports one
  secondsRunning: number // aggregate runtime seconds across all sessions incl. active ones (§13.3)
  roles: RoleItem[] // the pool — ambient roles rendered in the bottom dock
  columns: { name: string; c: string; states: string[]; inert?: boolean }[] // dashboard lanes from config (hot-reloaded); inert = no agent works these (parked/terminal). see WORKFLOW.md board.columns
  terminalStates?: string[] // states intentionally without a column (Done/Canceled/Duplicate) — excluded from the unmapped catch-all so it only flags real surprises (renames)
  gatewayAccounts: string[] // LLM-account tracking: which ChatGPT account each worker routes gpt-5.5 through ("label ×count")
  pollHealth?: { failureStreak: number; lastError: string | null; lastOkAt: number | null } // BEV-4025: consecutive Linear-poll failures — a banner fires once this streak is actionable, so a hung poll isn't silently invisible
}

// §13.7.2: JSON error envelope for /api/v1/* responses.
function apiErr(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } })
}

// A tiny status server: GET /state.json is the live orchestrator snapshot; GET / serves the Preact dashboard
// (bundled on the fly by Bun.serve's HTML-import routing — see ./dashboard-client) which polls/streams it and
// renders the board (kanban by pipeline stage) + a per-run log modal.
export function startDashboard(port: number, getSnapshot: () => Snapshot, getLog: (id: string) => string[], log: (m: string) => void, onAction?: (id: string, action: string) => Promise<{ ok: boolean; msg?: string }>, onChat?: (id: string, text: string) => Promise<{ ok: boolean; reply?: string; msg?: string }>, getStats?: Stats, getLive?: (id: string) => string): void {
  // Server-Sent Events push. Clients subscribe to /events (board) + /log-stream/<id> (transcript); a tight interval
  // diff-pushes so the dashboard reflects any change within ~150ms WITHOUT the client polling. /state.json + /transcript
  // stay live as the EventSource fallback (the exe.dev proxy could buffer SSE; the client degrades to polling cleanly).
  const te = new TextEncoder()
  const sse = (data: unknown): Uint8Array => te.encode(`data: ${JSON.stringify(data)}\n\n`)
  const boardClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  let lastBoardSig = ''
  const pushBoardNow = (): void => {
    if (boardClients.size === 0) return
    const s = getSnapshot()
    // Same structural signature the client render() uses (incl. the QA-blocked note term) — push only on a real change.
    const sig = JSON.stringify(s.items.map((i) => [i.identifier, i.state, i.status, i.host, i.prUrl, i.retryAttempt, i.state === 'QA blocked' ? (i.note ?? '') : '']))
    if (sig === lastBoardSig) return
    lastBoardSig = sig
    const msg = sse(s)
    for (const c of boardClients) try { c.enqueue(msg) } catch { boardClients.delete(c) }
  }
  const logClients = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>()
  const logLengths = new Map<string, number>()
  const lastLive = new Map<string, string>() // last-pushed streaming partial per id — so we only re-push on change
  const pushLogs = (): void => {
    for (const [id, ctls] of logClients) {
      if (ctls.size === 0) { logClients.delete(id); logLengths.delete(id); lastLive.delete(id); continue }
      const lines = getLog(id)
      const prev = logLengths.get(id) ?? 0
      if (lines.length !== prev) {
        // A from-scratch run resets getLog(id) to [] (orchestrator) — shrink => re-seed the client with the full log.
        const msg = lines.length < prev ? sse({ seed: true, lines }) : sse({ lines: lines.slice(prev) })
        logLengths.set(id, lines.length)
        for (const c of ctls) try { c.enqueue(msg) } catch { ctls.delete(c) }
      }
      // Realtime: push the agent's growing reply (ephemeral) whenever it changes; '' = the message committed → clear it.
      const live = getLive ? getLive(id) : ''
      if (live !== (lastLive.get(id) ?? '')) {
        lastLive.set(id, live)
        const msg = sse({ live })
        for (const c of ctls) try { c.enqueue(msg) } catch { ctls.delete(c) }
      }
    }
  }
  setInterval(() => { pushBoardNow(); pushLogs() }, 150)

  const noStore = { headers: { 'cache-control': 'no-store' } }
  const sseHeaders = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' }
  const cssHeaders = { 'content-type': 'text/css; charset=utf-8' }
  // Kicked off once at boot; every request just awaits the same cached promise (near-instant after the first).
  const dashboardCss = compileTailwindCss(`${import.meta.dir}/dashboard-client/styles.css`)
  const statsCss = compileTailwindCss(`${import.meta.dir}/dashboard-client/stats-styles.css`)

  Bun.serve({
    port,
    // §13.7 says SHOULD bind loopback by default UNLESS configured otherwise. This deployment is reached only through
    // the exe.dev share-proxy (the access boundary), which connects from outside loopback, so it binds all interfaces.
    routes: {
      // Bun.serve's HTML-import auto-bundling: JSX/TSX under dashboard-client is bundled on process boot with no
      // separate `bun build` step, and coexists cleanly with the plain function routes below (Bun tries `routes`
      // first, falling through to `fetch()` for anything not listed here). CSS is NOT part of this auto-bundling
      // (see compileTailwindCss's comment) — board.tsx/stats.tsx inject a <link> to the two routes below at runtime.
      '/': boardHtml,
      '/stats': statsHtml,
      '/dashboard.css': async () => new Response(await dashboardCss, { headers: cssHeaders }),
      '/stats.css': async () => new Response(await statsCss, { headers: cssHeaders }),
    },
    async fetch(req, server) {
      const url = new URL(req.url)

      // SSE board stream — full snapshot on connect, then the snapshot on every structural change (pushBoardNow).
      if (url.pathname === '/events') {
        server.timeout(req, 0) // BEV audit: Bun's default 10s idle timeout otherwise kills a long-lived SSE
        // connection the moment nothing changes for 10s, producing a recurring unstructured "request timed out"
        // stderr warning every ~10-30min in daemon.log with no correlation to a real problem — disable it for
        // this connection specifically (the abort listener below still cleans up on a real disconnect).
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            boardClients.add(c)
            c.enqueue(sse(getSnapshot()))
            req.signal.addEventListener('abort', () => { boardClients.delete(c); try { c.close() } catch {} })
          },
        })
        return new Response(stream, { headers: sseHeaders })
      }
      // SSE per-ticket transcript stream — seeds the full log on connect, then pushes appended lines (pushLogs).
      if (url.pathname.startsWith('/log-stream/')) {
        server.timeout(req, 0) // see /events above — same long-lived SSE connection, same idle-timeout exemption
        const id = decodeURIComponent(url.pathname.slice('/log-stream/'.length))
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            let set = logClients.get(id)
            if (!set) { set = new Set(); logClients.set(id, set) }
            set.add(c)
            const lines = getLog(id)
            if (set.size === 1) logLengths.set(id, lines.length)
            c.enqueue(sse({ seed: true, lines }))
            req.signal.addEventListener('abort', () => { logClients.get(id)?.delete(c); try { c.close() } catch {} })
          },
        })
        return new Response(stream, { headers: sseHeaders })
      }

      // §13.7.2 /api/v1/* — additive JSON REST API (does NOT remove legacy endpoints below)
      if (url.pathname.startsWith('/api/v1/')) {
        const sub = url.pathname.slice('/api/v1/'.length)

        if (sub === 'state') {
          // §13.7.2 GET /api/v1/state — full snapshot
          if (req.method !== 'GET') return apiErr('method_not_allowed', 'Use GET', 405)
          const snap = getSnapshot()
          return Response.json({
            generated_at: new Date().toISOString(),
            counts: {
              running: snap.items.filter(i => i.status === 'running').length,
              retrying: snap.items.filter(i => i.status === 'retrying').length,
            },
            items: snap.items,
            codex_totals: {
              total_tokens: snap.totalTokens,
              input_tokens: snap.totalInput,
              output_tokens: snap.totalOutput,
              cached_tokens: snap.totalCached,
              seconds_running: snap.secondsRunning, // §13.3
            },
            rate_limits: snap.rateLimits, // §13.3
            paused: snap.paused,
          }, noStore)
        }

        if (sub === 'refresh') {
          // §13.7.2 POST /api/v1/refresh — no clean way to trigger a poll from the dashboard layer
          // (the poll loop lives in the orchestrator which isn't passed in); return 202 with a note.
          if (req.method !== 'POST') return apiErr('method_not_allowed', 'Use POST', 405)
          return Response.json({
            queued: false,
            note: 'polling runs automatically on the configured interval; no external trigger available from the dashboard layer',
            requested_at: new Date().toISOString(),
          }, { status: 202, headers: { 'cache-control': 'no-store' } })
        }

        // §13.7.2 GET /api/v1/<issue_identifier>
        if (sub && !sub.includes('/')) {
          if (req.method !== 'GET') return apiErr('method_not_allowed', 'Use GET', 405)
          const identifier = decodeURIComponent(sub)
          const snap = getSnapshot()
          const item = snap.items.find(i => i.identifier === identifier)
          if (!item) return apiErr('issue_not_found', `Unknown identifier: ${identifier}`, 404)
          return Response.json({
            issue_identifier: item.identifier,
            status: item.status,
            state: item.state,
            host: item.host,
            turn: item.turn,
            activity: item.activity,
            started_at: item.startedAt ? new Date(item.startedAt).toISOString() : null,
            last_activity_at: item.lastActivity ? new Date(item.lastActivity).toISOString() : null,
            retry_attempt: item.retryAttempt,
            retry_due_at: item.retryDueAt ? new Date(item.retryDueAt).toISOString() : null,
            tokens: item.tokens,
            recent_events: getLog(identifier).slice(-20),
          }, noStore)
        }

        // Unknown /api/v1/* path
        return apiErr('not_found', 'Unknown /api/v1/ endpoint', 404)
      }

      if (url.pathname === '/state.json') return Response.json(getSnapshot(), noStore)
      if (url.pathname.startsWith('/transcript/')) return Response.json({ log: getLog(decodeURIComponent(url.pathname.slice('/transcript/'.length))) }, noStore)
      if (url.pathname === '/action' && req.method === 'POST') {
        if (!onAction) return Response.json({ ok: false, msg: 'actions disabled' })
        let body: { id?: string; action?: string }
        try {
          body = (await req.json()) as { id?: string; action?: string }
        } catch {
          return Response.json({ ok: false, msg: 'bad request' })
        }
        if (!body.id || !body.action) return Response.json({ ok: false, msg: 'missing id/action' })
        const res = await onAction(body.id, body.action)
        pushBoardNow() // flush the operator's own action to every connected dashboard immediately
        return Response.json(res)
      }
      if (url.pathname === '/chat' && req.method === 'POST') {
        if (!onChat) return Response.json({ ok: false, msg: 'chat disabled' })
        let body: { id?: string; text?: string }
        try {
          body = (await req.json()) as { id?: string; text?: string }
        } catch {
          return Response.json({ ok: false, msg: 'bad request' })
        }
        if (!body.id || !body.text) return Response.json({ ok: false, msg: 'missing id/text' })
        return Response.json(await onChat(body.id, body.text))
      }
      if (url.pathname === '/stats.json')
        return Response.json(getStats ? { totals: getStats.totals(), daily: getStats.daily(30), threads: getStats.threads('recent', 100) } : { totals: {}, daily: [], threads: [] }, noStore)
      return new Response('not found', { status: 404 })
    },
  })
  log(`dashboard on http://localhost:${port}`)
}
