import type { RateLimits } from './types'
import type { TokenBreakdown } from './tokens'
import type { Stats } from './stats'

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
}

// §13.7.2: JSON error envelope for /api/v1/* responses.
function apiErr(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } })
}

// A tiny status server: GET /state.json is the live orchestrator snapshot; GET / is a self-contained page that
// polls it and renders the board (kanban by pipeline stage) + a per-run log modal.
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
  Bun.serve({
    port,
    // §13.7 says SHOULD bind loopback by default UNLESS configured otherwise. This deployment is reached only through
    // the exe.dev share-proxy (the access boundary), which connects from outside loopback, so it binds all interfaces.
    async fetch(req) {
      const url = new URL(req.url)
      const noStore = { headers: { 'cache-control': 'no-store' } }
      const sseHeaders = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' }

      // SSE board stream — full snapshot on connect, then the snapshot on every structural change (pushBoardNow).
      if (url.pathname === '/events') {
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
      if (url.pathname === '/stats') return new Response(STATS_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    },
  })
  log(`dashboard on http://localhost:${port}`)
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>bunion</title>
<style>
*{box-sizing:border-box}
:root{--bg:#090a0e;--surf:#15171e;--surf2:#1b1e27;--surf3:#232733;--line:#23262f;--line2:#2e323d;--line3:#3b4150;--fg:#eef1f7;--mut:#99a0ad;--mut2:#5a6270;--accent:#5b8def;--accent2:#86acff;--sh1:0 1px 2px rgba(0,0,0,.45);--sh2:0 8px 26px rgba(0,0,0,.42)}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;height:100vh;overflow:hidden;background:var(--bg);background-image:radial-gradient(1100px 520px at 80% -10%,#14171f 0%,rgba(20,23,31,0) 60%),linear-gradient(180deg,#0b0d12 0%,#090a0e 100%);background-attachment:fixed;color:var(--fg);font:13.5px/1.5 -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
header{flex:0 0 auto;display:flex;align-items:center;gap:14px;padding:14px 22px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(11,12,17,.72);backdrop-filter:saturate(150%) blur(14px);z-index:10}
.brand{font-weight:650;letter-spacing:.2px;display:flex;align-items:center;gap:10px;font-size:14px}
.mark{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px #5b8def22,0 0 14px var(--accent)}
.sub{color:var(--mut);font-weight:400;font-size:12.5px;margin-left:2px;letter-spacing:.2px}
.stats{display:flex;gap:7px;margin-left:6px;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--surf);border:1px solid var(--line);border-radius:8px;padding:4px 10px;font-size:12px;box-shadow:var(--sh1)}
.chip i{width:7px;height:7px;border-radius:50%}
.cap{color:var(--mut);font-size:12px;align-self:center}
.search{margin-left:6px;background:var(--surf);border:1px solid var(--line);border-radius:8px;color:var(--fg);font:12.5px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:6px 11px;width:170px;outline:none;transition:width .15s,border-color .15s}
.search:focus{border-color:var(--accent);width:230px}
.search::placeholder{color:var(--mut2)}
.clock{margin-left:auto;color:var(--mut2);font-size:12px;font-variant-numeric:tabular-nums;font-family:ui-monospace,Menlo,monospace}
.pausebtn{margin-left:12px;background:#15171e;border:1px solid #4a3a1a;color:#d99a2b;border-radius:8px;padding:5px 13px;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:.2px;transition:background .15s,border-color .15s;white-space:nowrap}
.pausebtn:hover{background:#1d1810;border-color:#d99a2b}
.pausebtn.on{background:#11201a;border-color:#3fb27f;color:#3fb27f}
.grantbtn{margin-left:6px;background:#1a1622;border:1px solid #4a3a5a;color:#b88cd9;border-radius:6px;padding:1px 7px;font-size:11px;font-weight:700;cursor:pointer;vertical-align:baseline}
.grantbtn:hover{background:#221a2e;border-color:#b88cd9}
.grantbtn.busy{opacity:.5;pointer-events:none}
.runbtn{margin-left:8px;background:#15171e;border:1px solid #3a4a5a;color:#5b8def;border-radius:6px;padding:1px 8px;font-size:11px;font-weight:700;cursor:pointer}
.runbtn:hover{background:#161d28;border-color:#5b8def}
.runbtn.busy{opacity:.5;pointer-events:none}
.pausebtn.on:hover{background:#142a20}
#pausebanner{flex:0 0 auto;display:none;align-items:center;gap:10px;padding:9px 22px;background:linear-gradient(90deg,#2a1414,#1a0f0f);border-bottom:1px solid #5a2222;color:#e8a0a0;font-size:12.5px;font-weight:600}
#pausebanner.show{display:flex}
#pausebanner .pb-dot{width:8px;height:8px;border-radius:50%;background:#e0564f;box-shadow:0 0 8px #e0564f}
.board{flex:1 1 auto;min-height:0;display:flex;gap:14px;padding:22px 22px 16px;align-items:stretch;overflow-x:auto;overflow-y:hidden;scroll-behavior:smooth}
.board::-webkit-scrollbar{height:10px}
.board::-webkit-scrollbar-thumb{background:var(--line2);border-radius:6px}
.board::-webkit-scrollbar-thumb:hover{background:#3a4150}
.board::-webkit-scrollbar-track{background:transparent}
.col{flex:0 0 256px;min-width:0;max-width:256px;display:flex;flex-direction:column;gap:10px;min-height:0}
.colcards{display:flex;flex-direction:column;gap:10px;flex:1 1 auto;overflow-y:auto;overflow-x:hidden;min-height:0;padding-bottom:8px}
.colcards>*{flex-shrink:0}
.colcards::-webkit-scrollbar{width:8px}
.colcards::-webkit-scrollbar-thumb{background:var(--line2);border-radius:5px}
.colcards::-webkit-scrollbar-thumb:hover{background:#3a4150}
.colh{display:flex;align-items:center;gap:8px;padding:2px 4px 9px;font-size:11px;font-weight:700;color:var(--mut);letter-spacing:.7px;text-transform:uppercase}
.colh i{width:8px;height:8px;border-radius:50%}
.colh .ct{margin-left:auto;color:var(--mut);font-weight:600;font-variant-numeric:tabular-nums;background:var(--surf2);border:1px solid var(--line);border-radius:20px;min-width:22px;text-align:center;padding:1px 7px;font-size:10.5px;letter-spacing:0}
.colempty{color:#3a414e;font-size:11.5px;padding:16px 0;text-align:center;border:1px dashed var(--line);border-radius:10px}
.col.inert{opacity:.82}
.col.inert .colh{color:var(--mut2)}
.col.inert .colh i{opacity:.4}
.parked{font-size:9px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--mut2);background:var(--surf2);border:1px solid var(--line);border-radius:5px;padding:1px 6px;margin-left:8px}
.card{background:linear-gradient(180deg,var(--surf) 0%,#13151c 100%);border:1px solid var(--line);border-radius:12px;padding:12px 14px;cursor:pointer;overflow:hidden;box-shadow:var(--sh1);transition:transform .15s cubic-bezier(.2,.7,.2,1),border-color .15s,box-shadow .15s}
.card:hover{border-color:var(--line3);box-shadow:var(--sh2);transform:translateY(-2px)}
.card.run{border-left:2.5px solid var(--accent);padding-left:11.5px;background:linear-gradient(180deg,#171b24 0%,#13151c 100%);box-shadow:0 0 0 1px #5b8def1f,var(--sh2)}
.ctop{display:flex;align-items:center;justify-content:space-between;gap:8px}
.cid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:650;letter-spacing:-.2px;color:var(--fg)}
.pill{font-size:10px;font-weight:700;padding:2.5px 9px;border-radius:20px;white-space:nowrap;letter-spacing:.2px}
.ctitle{color:var(--mut);font-size:12.5px;margin-top:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4}
.cact{color:var(--mut);font-size:11.5px;margin-top:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.cfoot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:9px}
.ag{display:inline-flex;align-items:center;gap:6px;color:var(--mut);font-size:11.5px;white-space:nowrap}
.ag .dot{width:7px;height:7px;border-radius:50%}
.meta{display:inline-flex;align-items:center;gap:8px;min-width:0}
.host{color:var(--mut2);font-size:11px;max-width:92px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,Menlo,monospace}
.clk{color:var(--mut2);font-size:11px;font-variant-numeric:tabular-nums;font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
.pr{color:var(--accent);text-decoration:none;font-size:11px;font-weight:600;background:#5b8def1a;padding:2px 7px;border-radius:6px;white-space:nowrap}
.pr:hover{background:#5b8def2e}
.pri{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:6px;vertical-align:middle}
.pri.p1{background:#e5484d}.pri.p2{background:#e0843a}.pri.p3{background:#d9a62b}.pri.p4{background:#5b6675}
.creason{margin-top:8px;font-size:11.5px;color:#eaa6a0;background:#e0564f12;border:1px solid #e0564f33;border-radius:7px;padding:6px 8px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.ctr{display:inline-flex;align-items:center;gap:6px;flex:none}
.kebab{background:none;border:none;color:var(--mut2);font-size:15px;line-height:1;cursor:pointer;padding:1px 5px;border-radius:6px}
.kebab:hover{background:var(--surf2);color:var(--fg)}
#actmenu{position:fixed;z-index:999;background:var(--surf2);border:1px solid var(--line2);border-radius:9px;padding:5px;box-shadow:0 14px 36px rgba(0,0,0,.55);display:none;flex-direction:column;gap:2px;min-width:144px}
.actitem{display:block;width:100%;text-align:left;background:none;border:none;color:var(--fg);font:600 12.5px/1 inherit;padding:8px 11px;border-radius:6px;cursor:pointer;white-space:nowrap}
.actitem:hover{background:#2a2f3a}
.actitem.go{color:#9ec1ff}.actitem.danger{color:#eaa6a0}
#toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%) translateY(8px);z-index:80;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;padding:11px 18px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 14px 36px rgba(0,0,0,.55)}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
#toast.ok{background:#13241b;border:1px solid #2f6f4f;color:#7fd6a8}
#toast.err{background:#2a1414;border:1px solid #6f2f2f;color:#eaa6a0}
#msub{padding:9px 16px 0}
.mtitle2{font-size:14.5px;color:var(--fg);font-weight:500;line-height:1.4}
.mmeta{display:flex;gap:12px;flex-wrap:wrap;margin-top:7px;color:var(--mut);font-size:11.5px}
.mmeta .m{display:inline-flex;align-items:center;gap:5px;font-variant-numeric:tabular-nums}
.mmeta .m .pri{margin-right:0}
#mchat{display:flex;gap:8px;align-items:flex-end;margin:10px 16px 0}
#mmsg{flex:1;background:var(--surf2);border:1px solid var(--line2);border-radius:8px;color:var(--fg);font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:9px 11px;resize:vertical;min-height:38px;max-height:160px;outline:none;box-sizing:border-box}
#mmsg:focus{border-color:var(--accent)}
#mmsg::placeholder{color:var(--mut2)}
#msend{background:var(--accent);color:#fff;border:none;border-radius:8px;padding:0 16px;height:38px;font:600 13px/1 -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;white-space:nowrap;flex:none}
#msend:disabled{opacity:.5;cursor:default}
#mactions{display:flex;gap:8px;flex-wrap:wrap;margin:9px 16px 14px}
.mbtn{font:600 12px/1 inherit;color:var(--fg);background:var(--surf2);border:1px solid var(--line2);border-radius:8px;padding:8px 13px;cursor:pointer;transition:background .12s,border-color .12s}
.mbtn:hover{background:#2a2f3a;border-color:#3a4150}
.mbtn.go{color:#9ec1ff;border-color:#5b8def55}.mbtn.go:hover{background:#5b8def1f}
.mbtn.danger{color:#eaa6a0;border-color:#e0564f55}.mbtn.danger:hover{background:#e0564f1a}
.mbtn.busy{opacity:.6;pointer-events:none}
.empty{color:var(--mut);padding:64px;text-align:center;width:100%}
#dock{flex:0 0 auto;padding:12px 22px 16px;border-top:1px solid var(--line);background:linear-gradient(180deg,rgba(11,12,17,.35),rgba(9,10,14,.85))}
.docklab{font-size:11px;letter-spacing:.7px;text-transform:uppercase;color:var(--mut);font-weight:700;margin:0 4px 11px}
.dockrow{display:flex;gap:14px;flex-wrap:wrap}
.rcard{flex:0 0 292px;max-width:360px;background:linear-gradient(180deg,var(--surf) 0%,#13151c 100%);border:1px solid var(--line);border-left:2.5px solid var(--accent);border-radius:12px;padding:13px 15px;cursor:pointer;box-shadow:var(--sh1);transition:transform .15s cubic-bezier(.2,.7,.2,1),border-color .15s,box-shadow .15s}
.rcard:hover{transform:translateY(-2px);box-shadow:var(--sh2);border-color:var(--line3)}
.rcard.paused{opacity:.6;border-style:dashed}
.rcard.paused:hover{opacity:.82}
.pausebtn-r{margin-left:6px;background:#1a1410;border:1px solid #4a3a1a;color:#d99a2b;border-radius:6px;padding:1px 7px;font-size:11px;font-weight:700;cursor:pointer}
.pausebtn-r:hover{background:#221a10;border-color:#d99a2b}
.rtop{display:flex;align-items:center;gap:8px}
.rname{font-weight:650;font-size:13.5px;text-transform:capitalize;letter-spacing:.2px}
.rmodel{font-size:10px;color:var(--mut2);font-family:ui-monospace,Menlo,monospace;background:var(--surf2);border:1px solid var(--line);border-radius:5px;padding:1.5px 6px}
.rstat{margin-left:auto;font-size:11px;color:var(--mut);display:inline-flex;align-items:center;gap:5px}
.rstat .dot{width:7px;height:7px;border-radius:50%}
.ract{color:var(--mut);font-size:12px;margin-top:9px;line-height:1.45;min-height:17px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rfoot{font-size:11px;color:var(--mut2);margin-top:9px;font-variant-numeric:tabular-nums}
#modal{position:fixed;inset:0;background:rgba(5,6,10,.66);backdrop-filter:blur(7px);display:none;align-items:center;justify-content:center;z-index:50;padding:28px}
#mpanel{background:var(--surf);border:1px solid var(--line2);border-radius:16px;width:min(960px,100%);max-height:86vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 30px 90px rgba(0,0,0,.66),0 0 0 1px rgba(255,255,255,.02)}
#mhead{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap;background:linear-gradient(180deg,#191c24 0%,var(--surf) 100%)}
#mbanner{margin:11px 16px 0;padding:9px 12px;border-radius:9px;font-size:12.5px;line-height:1.5}
#mbanner.nh{background:#e0564f18;border:1px solid #e0564f44;color:#eaa6a0}
#mbanner.nh b{color:#e0564f}
#mbanner.note{background:var(--surf2);border:1px solid var(--line);color:var(--mut)}
#mtokens{margin:11px 16px 0;display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:12px}
#mtokens .tklab{text-transform:uppercase;letter-spacing:.5px;font-size:10px;color:var(--mut2)}
#mtokens .tkph{background:var(--surf2);border:1px solid var(--line);border-radius:6px;padding:2px 8px;color:var(--mut);font-family:ui-monospace,Menlo,monospace}
#mtokens .tkph b{color:var(--fg);font-weight:600;text-transform:capitalize}
#mtokens .tktot{margin-left:auto;color:var(--fg);font-family:ui-monospace,Menlo,monospace;font-weight:600}
#mtitle{display:flex;align-items:center;gap:10px;font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:14px}
#mclose{margin-left:auto;cursor:pointer;color:var(--mut);font-size:12.5px}
#mclose:hover{color:var(--fg)}
#logbody{margin:0;padding:4px 18px 20px;overflow:auto;flex:1;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
.lg{padding:0}
.lg-turn{margin:18px 0 2px;color:#5b8def;font:700 10.5px/1 ui-monospace,Menlo,monospace;border-top:1px solid var(--line);padding-top:13px;letter-spacing:1.5px;text-transform:uppercase}
.lg-msg{color:var(--fg);font-size:13px;line-height:1.62;margin:10px 0;padding:9px 13px;border-left:2px solid #3a9168;background:var(--surf2);border-radius:8px}
.lg-live{color:var(--fg);font-size:13px;line-height:1.62;margin:10px 0;padding:9px 13px;border-left:2px solid #3a9168;background:var(--surf2);border-radius:8px;white-space:pre-wrap}
.lg-cur{display:inline-block;width:6px;height:14px;margin-left:1px;background:#3a9168;vertical-align:text-bottom;animation:blink 1s step-start infinite}
@keyframes blink{50%{opacity:0}}
.lg-op{color:var(--fg);font-size:13px;line-height:1.62;margin:10px 0;padding:9px 13px;border-left:2px solid var(--accent);background:#5b8def14;border-radius:8px}
.lg-op b{color:var(--accent2);font-weight:700;margin-right:7px;text-transform:uppercase;font-size:9.5px;letter-spacing:.7px}
.lg-cmd{color:var(--mut2);font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:2.5px 0 2.5px 13px}
.lg-cmd b{color:#5b8def;font-weight:700;margin-right:3px}
.lg-tool{color:#d99a2b;font:11.5px/1.45 ui-monospace,Menlo,monospace;padding:2px 0 2px 13px;opacity:.9}
.lg-edit{color:#b88cd9;font:11.5px/1.45 ui-monospace,Menlo,monospace;padding:2px 0 2px 13px}
.lg-typing{display:flex;align-items:center;gap:9px;color:var(--mut);font-size:12.5px;margin:10px 0;padding:10px 13px;border-left:2px solid #3a9168;background:var(--surf2);border-radius:8px}
.tdots{display:inline-flex;gap:4px}
.tdot{width:6px;height:6px;border-radius:50%;background:#3a9168;animation:tbounce 1.25s infinite ease-in-out}
.tdot:nth-child(2){animation-delay:.16s}.tdot:nth-child(3){animation-delay:.32s}
@keyframes tbounce{0%,65%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}
.live{width:7px;height:7px;border-radius:50%;background:#3fb27f;flex:none;animation:pulse 1.5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
/* --- interactivity pass: focus rings, press feedback, motion (gated by prefers-reduced-motion) --- */
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.card:focus-visible,.rcard:focus-visible{outline-offset:3px;border-color:var(--line3)}
.card.kbfocus{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent),var(--sh2)}
.flipping{will-change:transform;z-index:2}
@keyframes runpulse{0%,100%{box-shadow:0 0 0 1px #5b8def1f,var(--sh2)}50%{box-shadow:0 0 0 1px #5b8def4d,0 0 20px #5b8def26,var(--sh2)}}
@keyframes skim{from{opacity:.32}to{opacity:.7}}
.lg-skel{height:13px;border-radius:5px;background:var(--surf3);margin:11px 0;animation:skim 1.15s ease-in-out infinite alternate}
.lg-skel.s2{width:82%}.lg-skel.s3{width:64%}.lg-skel.s4{width:90%}.lg-skel.s5{width:72%}
@media(prefers-reduced-motion:no-preference){
 .mbtn:active{transform:scale(.97);opacity:.85}
 .grantbtn:active,.runbtn:active{transform:scale(.95)}
 .pausebtn:active{transform:scale(.98)}
 .card.run{animation:runpulse 2.4s ease-in-out infinite}
 #mpanel{transform:scale(.975);opacity:0;transition:transform .19s cubic-bezier(.2,.8,.2,1),opacity .16s}
 #modal.open #mpanel{transform:scale(1);opacity:1}
}
</style></head><body>
<header>
 <div class="brand"><span class="mark"></span>bunion<span class="sub" id="scope"></span></div>
 <div class="stats" id="stats"></div>
 <input id="search" class="search" type="search" placeholder="filter tickets&hellip;" oninput="setFilter(this.value)" aria-label="Filter tickets by id, title, host, or state">
 <span class="clock" id="clock"></span>
 <a href="/stats" target="_blank" rel="noopener" title="rollups + thread stats" style="margin-left:12px;color:var(--mut);font-size:12px;text-decoration:none;padding:5px 11px;border:1px solid var(--line);border-radius:8px;background:var(--surf);white-space:nowrap">&#128202; stats</a>
 <button id="pausebtn" class="pausebtn" onclick="postAction(this,'__pause__','toggle',event)">&#9208; Pause</button>
</header>
<div id="pausebanner" role="status" aria-live="polite"></div>
<div class="board" id="board"></div>
<div id="dock"></div>
<div id="modal"><div id="mpanel" role="dialog" aria-modal="true" aria-labelledby="mtitle">
 <div id="mhead"><span class="live"></span><span id="mtitle"></span><span id="mclose" role="button" tabindex="0" aria-label="Close">close &#10005;</span></div>
 <div id="msub"></div>
 <div id="mbanner" style="display:none"></div>
 <div id="mtokens" style="display:none"></div>
 <div id="logbody"></div>
 <div id="mchat"><textarea id="mmsg" rows="1" aria-label="Message the agent" placeholder="Message the agent — it can answer or act on steering (move state, update the plan)" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat();}"></textarea><button id="msend" onclick="sendChat()">Send</button></div>
 <div id="mactions"></div>
</div></div>
<div id="actmenu"></div>
<div id="toast" role="status" aria-live="polite"></div>
<script>
const SC=s=>({'Triage':'#7c8493','Backlog':'#7c8493','Todo':'#7c8493','In Progress':'#5b8def','QA Requested':'#d99a2b','QA Verify':'#c79a3a','QA blocked':'#e0564f','Needs Engineer':'#d9568c','STG - Ready to merge':'#3fb27f','Done':'#a371f7'}[s]||'#7c8493');
const ago=ms=>{let s=Math.max(0,Math.floor(ms/1000));if(s<60)return s+'s';let m=Math.floor(s/60);if(m<60)return m+'m '+(s%60)+'s';return Math.floor(m/60)+'h '+(m%60)+'m'};
const esc=s=>(s||'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
const fmtTok=n=>{n=n||0;return n>=1e9?(n/1e9).toFixed(2)+'B':n>=1e6?(n/1e6).toFixed(n>=1e8?0:1)+'M':n>=1e4?Math.round(n/1e3)+'k':n>=1e3?(n/1e3).toFixed(1)+'k':String(n)};
// API-equivalent $ at ~GPT-5.5 rates ($ per 1M tokens) — what this volume WOULD cost on the OpenAI API. Actual spend
// is flat (the exe.dev plan + a ChatGPT subscription), NOT per-token, so this is value extracted, not a bill.
var COST_IN=5,COST_CACHED=0.5,COST_OUT=30;
function estCost(input,output,cached){var unc=Math.max(0,(input||0)-(cached||0));return (unc*COST_IN+(cached||0)*COST_CACHED+(output||0)*COST_OUT)/1e6;}
function fmtCost(d){return d>=10000?'$'+Math.round(d/1e3)+'k':d>=100?'$'+Math.round(d):d>=1?'$'+d.toFixed(1):'$'+d.toFixed(2);}
const PRI={1:'Urgent',2:'High',3:'Medium',4:'Low'};
var A_REWORK={a:'to-build',l:'Back to coding',c:'',t:'Move to In Progress so the agent resumes the thread, revises the code, and updates the PR'};
function actionList(it){if(!it||it.state==='Done')return [];
 if(it.status==='running')return [{a:'restart',l:'Restart this agent',c:'danger',t:'Stop the current agent, wipe its workspace, and restart the ticket from scratch on a fresh thread'},A_REWORK];
 if(it.state==='Needs Engineer')return [{a:'bump',l:'Bump budget & reopen',c:'go',t:'Grant another token budget on top of the cap and re-open to In Progress (use for a ticket parked by the token cap)'},{a:'to-qa',l:'Back to QA',c:'go',t:'Send back to QA Requested so the agent re-verifies'},A_REWORK];
 if(it.state==='STG - Ready to merge')return [{a:'to-qa',l:'Re-verify',c:'go',t:'Send back to QA Requested for the agent to re-verify before shipping'},A_REWORK];
 return [{a:'to-qa',l:'Send to QA',c:'go',t:'Move to QA Requested so the agent verifies the work'},A_REWORK];}
function abtn(id,d){return '<button class="mbtn '+(d.c||'')+'" title="'+(d.t||'')+'" onclick="modalAct(\\''+id+'\\',\\''+d.a+'\\',event)">'+d.l+'</button>';}
function kebab(it){return actionList(it).length?'<button class="kebab" data-id="'+it.identifier+'" onclick="toggleMenu(this,event)" title="actions" aria-label="Actions for '+it.identifier+'" aria-haspopup="menu">&#8943;</button>':'';}
let COLS=[
 {name:'Planning',c:'#8b93a1',states:['Triage','Backlog','Todo']},
 {name:'In Progress',c:'#5b8def',states:['In Progress']},
 {name:'QA check',c:'#d99a2b',states:['QA Requested']},
 {name:'Verify QA',c:'#c79a3a',states:['QA Verify']},
 {name:'Blocked',c:'#e0564f',states:['QA blocked']},
 {name:'Needs Engineer',c:'#d9568c',states:['Needs Engineer'],inert:true},
 {name:'Ready',c:'#3fb27f',states:['STG - Ready to merge'],inert:true},
 {name:'In Staging',c:'#e3b341',states:['STG - Merged'],inert:true},
 {name:'Verifying prod',c:'#4a9eda',states:['Verifying in Prod']},
 {name:'Done',c:'#6b7280',states:['Done'],inert:true}];
function colIdx(st){var l=(st||'').trim().toLowerCase();for(var i=0;i<COLS.length;i++)for(var j=0;j<COLS[i].states.length;j++)if(COLS[i].states[j].toLowerCase()===l)return i;return -1;}
function moveItems(it){if(!it)return [];var cur=colIdx(it.state);return COLS.map(function(col,i){return i===cur?null:{a:'move:'+col.states[0],l:'\\u2192 '+col.name,c:'',t:'Move this ticket to '+col.name};}).filter(Boolean);}
let snap={items:[],cap:0,scope:''};
var optimisticOverrides={};var logCache=new Map();var logEs=null,_logPoll=null,_pollFallback=null,logCount=0;
async function pull(){try{snap=await (await fetch('/state.json',{cache:'no-store'})).json();if(snap.columns&&snap.columns.length)COLS=snap.columns;}catch(e){}render()}
function cardHtml(r,now){
 const run=r.status==='running';
 const act=now-r.lastActivity,dc=act<30000?'#3fb27f':act<120000?'#d99a2b':'#e0564f';
 const pr=r.prUrl?'<a class="pr" href="'+r.prUrl+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">#'+(r.prUrl.split("/pull/")[1]||"")+'</a>':'';
 let status;
 if(run) status='<span class="ag t-ago"><i class="dot" style="background:'+dc+'"></i>active '+ago(act)+'</span>';
 else if(r.status==='retrying') status='<span class="ag">&#8635; retry '+(r.retryDueAt?'in '+ago(r.retryDueAt-now):'soon')+'</span>';
 else if(r.state==='Needs Engineer') status='<span class="ag" style="color:#d9568c">&#9888; needs engineer</span>';
 else if(r.state==='Done') status='<span class="ag" style="color:#a371f7">&#10004; merged</span>';
 else if(r.state==='STG - Ready to merge') status='<span class="ag" style="color:#3fb27f">&#10004; ready</span>';
 else if(r.status==='handoff') status='<span class="ag">&#10004; in review</span>';
 else status='<span class="ag">&#9203; queued</span>';
 const tot=r.enteredAt?'<span class="t-tot clk" title="total time in the factory">&#9201; '+ago((r.endedAt||now)-r.enteredAt)+'</span>':'';
 const tcst=r.tokens?estCost(r.tokens.phases.reduce(function(a,p){return a+p.input},0),r.tokens.phases.reduce(function(a,p){return a+p.output},0),r.tokens.phases.reduce(function(a,p){return a+p.cached},0)):0;
 const tk=r.tokens?'<span class="t-tok clk" title="'+fmtTok(r.tokens.total)+' tokens &middot; ~'+fmtCost(tcst)+' at API rates &middot; flat plan, not per-token">'+fmtTok(r.tokens.total)+' tok</span>':'<span class="t-tok"></span>';
 const pdot=(r.priority>=1&&r.priority<=4)?'<i class="pri p'+r.priority+'" title="'+PRI[r.priority]+' priority"></i>':'';
 const reason=((r.state==='QA blocked'||r.state==='Needs Engineer')&&r.note)?'<div class="creason" title="why it is stuck">'+esc(r.note.slice(0,160))+'</div>':'';
 return '<div class="card'+(run?' run':'')+'" data-id="'+r.identifier+'" tabindex="0" aria-label="Open '+r.identifier+'">'+
  '<div class="ctop"><span class="cid">'+pdot+r.identifier+'</span><span class="ctr">'+pr+kebab(r)+'</span></div>'+
  '<div class="ctitle">'+esc(r.title)+'</div>'+
  (run?'<div class="cact t-act">turn '+(r.turn||0)+' &middot; '+esc((r.activity||'').slice(0,70))+'</div>':'')+
  reason+
  '<div class="cfoot">'+status+'<span class="meta">'+tk+tot+'</span></div>'+
 '</div>';
}
function colHtml(col,arr,now){var inert=!!col.inert;return '<div class="col'+(inert?' inert':'')+'"><div class="colh"><i style="background:'+col.c+'"></i>'+col.name+(inert?'<span class="parked" title="the factory does not work these — they wait on a person, the release train, or are already done">parked</span>':'')+'<span class="ct">'+arr.length+'</span></div><div class="colcards">'+(arr.length?arr.map(r=>cardHtml(r,now)).join(''):'<div class="colempty">empty</div>')+'</div></div>';}
function flip(first){document.querySelectorAll('#board .card[data-id]').forEach(function(c){var id=c.getAttribute('data-id'),f=first[id];if(!f)return;var l=c.getBoundingClientRect(),dx=f.left-l.left,dy=f.top-l.top;if(!dx&&!dy)return;c.classList.add('flipping');c.style.transition='none';c.style.transform='translate('+dx+'px,'+dy+'px)';requestAnimationFrame(function(){c.style.transition='transform .32s cubic-bezier(.2,.7,.2,1)';c.style.transform='';});c.addEventListener('transitionend',function h(){c.style.transition='';c.style.transform='';c.classList.remove('flipping');c.removeEventListener('transitionend',h);});});}
let lastSig='';
var filterQuery='';
function setFilter(v){filterQuery=(v||'').trim().toLowerCase();render();}
function render(){
 const items=snap.items||[];
 const filtered=filterQuery?items.filter(function(r){return (r.identifier+' '+(r.title||'')+' '+(r.host||'')+' '+(r.state||'')).toLowerCase().indexOf(filterQuery)>=0}):items;
 var _byId={};items.forEach(function(r){_byId[r.identifier]=r});for(var _oid in optimisticOverrides){var _ov=optimisticOverrides[_oid],_it=_byId[_oid];if(!_it||_it.state===_ov.state||Date.now()>_ov.expiresAt)delete optimisticOverrides[_oid];}
 var effState=function(r){var o=optimisticOverrides[r.identifier];return o?o.state:r.state;};
 const run=items.filter(r=>r.status==='running').length,q=items.filter(r=>r.status==='queued').length,rt=items.filter(r=>r.status==='retrying').length;
 scope.textContent=snap.scope||'';
 var pb=document.getElementById('pausebtn'),pbn=document.getElementById('pausebanner');if(pb){if(snap.paused){pb.className='pausebtn on';pb.innerHTML='&#9654; Resume';pbn.className='show';pbn.innerHTML='<span class="pb-dot"></span><b>FACTORY PAUSED</b> &middot; dispatch halted, agents stopped &mdash; click Resume to continue';}else{pb.className='pausebtn';pb.innerHTML='&#9208; Pause';pbn.className='';}}
 const chip=(col,n,lab)=>'<span class="chip"><i style="background:'+col+'"></i>'+n+' '+lab+'</span>';
 // §13.3 rate-limit chip: amber ≥80%, red ≥95%; resetsIn countdown when known
 function rlChip(rl){if(!rl||rl.usedPercent==null)return '';var pct=rl.usedPercent,col=pct>=95?'#e0564f':pct>=80?'#d99a2b':'#3fb27f',bg=pct>=95?'#e0564f22':pct>=80?'#d99a2b22':'';var label=Math.round(pct)+'% rl'+(rl.resetsInSeconds!=null?' ('+Math.round(rl.resetsInSeconds)+'s)':'');return '<span class="chip" title="rate-limit usage (Symphony §13.3)" style="'+(bg?'background:'+bg+';border-color:'+col+'44;':'')+'"><i style="background:'+col+'"></i><span style="color:'+col+'">'+label+'</span></span>';}
 // §13.3 secondsRunning: aggregate runtime across all sessions
 var sr=snap.secondsRunning||0,srH=Math.floor(sr/3600),srM=Math.floor((sr%3600)/60),srS=Math.floor(sr%60);
 var srStr=(srH?srH+'h ':'')+(srH||srM?srM+'m':srS+'s');
 stats.innerHTML=chip('#3fb27f',run,'running')+(q?chip('#7c8493',q,'queued'):'')+(rt?chip('#d99a2b',rt,'retrying'):'')+'<span class="cap">'+(snap.cap||0)+' slots</span>'+(snap.totalTokens?'<span class="cap" title="What this volume would cost at GPT-5.5 API rates. Actual spend is flat (the exe.dev plan + a ChatGPT subscription), not per-token — value extracted, not a bill.">&#931; '+fmtTok(snap.totalTokens)+' tok'+(snap.totalInput?' &middot; <b style="color:#3fb27f">'+Math.round(snap.totalCached/snap.totalInput*100)+'% cached</b>':'')+' &middot; ~'+fmtCost(estCost(snap.totalInput,snap.totalOutput,snap.totalCached))+' at API rates</span>':'')+(sr?'<span class="cap" title="aggregate runtime across all sessions (Symphony §13.3 secondsRunning)">&#9201; '+srStr+'</span>':'')+((snap.gatewayAccounts&&snap.gatewayAccounts.length)?'<span class="cap" title="ChatGPT account each worker routes gpt-5.5 through (resolved live from each worker config); your ChatGPT subscriptions via the exe.dev gateway, not the OpenAI API">&#128273; via '+snap.gatewayAccounts.map(function(a){return esc(a)}).join(', ')+'</span>':'')+rlChip(snap.rateLimits);
 // Rebuild the board ONLY when structure changes (membership / state / status / pr); live fields tick in place.
 const sig=JSON.stringify(filtered.map(r=>[r.identifier,effState(r),r.status,r.host,r.prUrl,r.retryAttempt,effState(r)==='QA blocked'?(r.note||''):''])) + '|' + filterQuery;
 if(sig!==lastSig){
  lastSig=sig;const now=Date.now();
  var _motion=!window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  var _first={};if(_motion)document.querySelectorAll('#board .card[data-id]').forEach(function(c){_first[c.getAttribute('data-id')]=c.getBoundingClientRect();});
  if(!filtered.length){board.innerHTML='<div class="empty">'+(filterQuery?'no tickets match &ldquo;'+esc(filterQuery)+'&rdquo;':'no '+esc(snap.scope||'dark-factory')+' tickets in scope')+'</div>';}
  else{
   const bk=COLS.map(()=>[]);var unmapped=[];var term=(snap.terminalStates||[]).map(function(s){return s.toLowerCase()});
   for(const r of filtered){const i=colIdx(effState(r));if(i>=0)bk[i].push(r);else if(term.indexOf(effState(r).toLowerCase())<0)unmapped.push(r);}  // unmapped = no column AND not an intentionally-hidden terminal state — a renamed state surfaces; Done/Canceled/Duplicate don't
   var html=COLS.map((col,i)=>colHtml(col,bk[i],now)).join('');
   if(unmapped.length){var us=[...new Set(unmapped.map(function(r){return effState(r)}))].join(', ');html+=colHtml({name:'&#9888; unmapped &mdash; '+esc(us),c:'#e0564f',states:[]},unmapped,now);}
   board.innerHTML=html;
   if(_motion)flip(_first);
  }
 }
 renderDock();
 tickLive();
}
function tickLive(){
 const now=Date.now();clock.textContent=new Date().toLocaleTimeString();
 const byId={};(snap.items||[]).forEach(function(r){byId[r.identifier]=r});
 document.querySelectorAll('#board .card[data-id]').forEach(function(card){
  const r=byId[card.getAttribute('data-id')];if(!r)return;
  const tt=card.querySelector('.t-tot');if(tt&&r.enteredAt)tt.innerHTML='&#9201; '+ago((r.endedAt||now)-r.enteredAt);
  const ag=card.querySelector('.t-ago');if(ag){const act=now-r.lastActivity,dc=act<30000?'#3fb27f':act<120000?'#d99a2b':'#e0564f';ag.innerHTML='<i class="dot" style="background:'+dc+'"></i>active '+ago(act)}
  const ac=card.querySelector('.t-act');if(ac)ac.innerHTML='turn '+(r.turn||0)+' &middot; '+esc((r.activity||'').slice(0,72));
  const tk=card.querySelector('.t-tok');if(tk)tk.innerHTML=r.tokens?fmtTok(r.tokens.total)+' tok':'';
 });
}
function roleColor(n){n=(n||'').toLowerCase();return n==='mechanic'?'#d99a2b':n==='dreamer'?'#b88cd9':n==='user-advocate'?'#3fb29e':'#5b8def';}
function pauseToggle(r){return r.paused?'<button class="runbtn" title="resume '+esc(r.name)+'" onclick="postAction(this,\\''+esc(r.name)+'\\',\\'pause\\',event)">&#9654; resume</button>':'<button class="pausebtn-r" title="pause '+esc(r.name)+' (stop its cadence runs)" onclick="postAction(this,\\''+esc(r.name)+'\\',\\'pause\\',event)">&#9208;</button>';}
function roleCard(r){var live=r.status==='running',paused=!!r.paused,col=roleColor(r.name),dc=paused?'#5a6270':(live?'#3fb27f':'var(--mut2)');
 var cap=r.maxPerDay!=null?r.maxPerDay+(r.granted||0):null;var capped=cap!=null&&r.filedToday>=cap;
 var stat=paused?'paused':(live?'working':(capped?'capped today':(r.lastRunAt?'last run '+ago(Date.now()-r.lastRunAt)+' ago':'idle')));
 var act=paused?'<span style="color:var(--mut2)">paused by operator &middot; no cadence runs until resumed</span>':(live?esc((r.activity||'working\\u2026').slice(0,120)):'<span style="color:var(--mut2)">'+(capped?'daily cap reached &middot; resumes at UTC midnight':'waiting for next run')+'</span>');
 return '<div class="rcard'+(paused?' paused':'')+'" data-role="'+esc(r.name)+'" style="border-left-color:'+col+'"><div class="rtop"><span class="rname" style="color:'+col+'">'+esc(r.name)+'</span>'+(r.model?'<span class="rmodel">'+esc(r.model)+'</span>':'')+'<span class="rstat"><i class="dot" style="background:'+dc+'"></i>'+stat+'</span>'+((live||paused)?'':'<button class="runbtn" title="run '+esc(r.name)+' now (skip the cadence wait)" onclick="postAction(this,\\''+esc(r.name)+'\\',\\'run\\',event)">&#9654; run</button>')+pauseToggle(r)+'</div><div class="ract">'+act+'</div><div class="rfoot">&#8635; every '+ago(r.cadenceMs)+(r.maxPerDay!=null?' &middot; <span style="color:'+(capped?'#d99a2b':'var(--mut2)')+'">'+r.filedToday+'/'+cap+' today'+((r.granted||0)>0?' (+'+r.granted+')':'')+'</span> <button class="grantbtn" title="grant '+esc(r.name)+' +'+r.maxPerDay+' tickets for today" onclick="postAction(this,\\''+esc(r.name)+'\\',\\'grant\\',event)">+'+r.maxPerDay+'</button>':'')+(r.tokens?' &middot; &#931; '+fmtTok(r.tokens)+' tok':'')+(r.host?' &middot; '+esc(r.host.replace(/\\.exe\\.xyz$/,'')):'')+'</div></div>';}
var lastDockSig='';
function renderDock(){var d=document.getElementById('dock');var roles=(snap.roles||[]);if(!roles.length){d.style.display='none';d.innerHTML='';lastDockSig='';return;}d.style.display='block';var sig=JSON.stringify(roles.map(function(r){return [r.name,r.status,r.activity,r.filedToday,r.granted,r.maxPerDay,r.lastRunAt,r.tokens,r.host,r.model,r.paused]}));if(sig===lastDockSig)return;lastDockSig=sig;d.innerHTML='<div class="docklab">&#9670; the pool &middot; always-on</div><div class="dockrow">'+roles.map(roleCard).join('')+'</div>';}
function renderRoleHead(r){var live=r.status==='running';
 document.getElementById('mtitle').innerHTML='<span style="text-transform:capitalize;color:'+roleColor(r.name)+'">'+esc(r.name)+'</span> <span class="pill" style="color:var(--mut);background:#8b929e1a">pool role</span>'+(r.model?' <span class="pill" style="color:var(--mut2);background:#8b929e14;font-family:ui-monospace,Menlo,monospace">'+esc(r.model)+'</span>':'');
 var meta=['<span class="m">'+(live?'<i class="dot" style="background:#3fb27f"></i>working':'<i class="dot" style="background:var(--mut2)"></i>idle')+'</span>','<span class="m">&#8635; every '+ago(r.cadenceMs)+'</span>'];
 if(r.maxPerDay!=null)meta.push('<span class="m">'+r.filedToday+'/'+(r.maxPerDay+(r.granted||0))+' filed today'+((r.granted||0)>0?' (+'+r.granted+' granted)':'')+'</span>');
 if(r.lastRunAt)meta.push('<span class="m">last run '+ago(Date.now()-r.lastRunAt)+' ago</span>');
 if(r.tokens)meta.push('<span class="m">&#931; '+fmtTok(r.tokens)+' tok</span>');
 if(r.host)meta.push('<span class="m">&#9709; '+esc(r.host.replace(/\\.exe\\.xyz$/,''))+'</span>');
 document.getElementById('msub').innerHTML='<div class="mtitle2">'+(live?esc(r.activity||'working\\u2026'):'idle \\u2014 waiting for the next run')+'</div><div class="mmeta">'+meta.join('')+'</div>';
 document.getElementById('mbanner').style.display='none';document.getElementById('mtokens').style.display='none';document.getElementById('mactions').style.display='none';document.getElementById('mchat').style.display='flex';document.getElementById('mmsg').placeholder='Prompt '+r.name+' \\u2014 steer it; it acts on its next run';}
let expandedId=null;
function syncHead(){var role=(snap.roles||[]).find(x=>x.name===expandedId);if(role){renderRoleHead(role);return;}document.getElementById('mchat').style.display='flex';document.getElementById('mmsg').placeholder='Message the agent \\u2014 answer or act on steering (move state, update the plan)';var it=(snap.items||[]).find(x=>x.identifier===expandedId);if(it&&optimisticOverrides[it.identifier])it=Object.assign({},it,{state:optimisticOverrides[it.identifier].state});const c=it?SC(it.state):'#7c8493';
 document.getElementById('mtitle').innerHTML=esc(expandedId||'')+(it?' <span class="pill" style="color:'+c+';background:'+c+'22">'+esc(it.state)+'</span>':'')+(it&&it.prUrl?' <a class="pr" href="'+it.prUrl+'" target="_blank" rel="noopener">PR #'+(it.prUrl.split("/pull/")[1]||"")+'</a>':'')+(it&&it.url?' <a class="pr" style="background:#8b929e1a;color:var(--mut)" href="'+it.url+'" target="_blank" rel="noopener">Linear &#8599;</a>':'');
 const sub=document.getElementById('msub');
 if(it){var m=[];
  if(it.priority>=1&&it.priority<=4)m.push('<span class="m"><i class="pri p'+it.priority+'"></i>'+PRI[it.priority]+'</span>');
  if(it.enteredAt)m.push('<span class="m" title="total time in the factory">&#9201; '+ago((it.endedAt||Date.now())-it.enteredAt)+'</span>');
  if(it.status==='running')m.push('<span class="m">&#9210; turn '+(it.turn||0)+'</span>');
  if(it.host)m.push('<span class="m">&#9709; '+esc(it.host.replace(/\\.exe\\.xyz$/,''))+'</span>');
  if(it.tokens)m.push('<span class="m" title="total tokens">&#931; '+fmtTok(it.tokens.total)+' tok</span>');
  sub.innerHTML='<div class="mtitle2">'+esc(it.title||'')+'</div>'+(m.length?'<div class="mmeta">'+m.join('')+'</div>':'');
 }else sub.innerHTML='';
 const ban=document.getElementById('mbanner');
 if(it&&it.state==='Needs Engineer'){ban.style.display='block';ban.className='nh';ban.innerHTML='<b>&#9888; Needs Engineer</b> &mdash; '+(it.note?esc(it.note):'open the workpad in Linear for the decision needed');}
 else if(it&&it.note&&it.status!=='running'){ban.style.display='block';ban.className='note';ban.innerHTML=esc(it.note);}
 else{ban.style.display='none';}
 const tk=document.getElementById('mtokens');
 if(it&&it.tokens){var tcached=0,tinput=0,toutput=0;it.tokens.phases.forEach(function(p){tcached+=p.cached;tinput+=p.input;toutput+=p.output});var mc=estCost(tinput,toutput,tcached);tk.style.display='flex';tk.innerHTML='<span class="tklab">tokens</span>'+it.tokens.phases.map(function(p){return '<span class="tkph" title="input '+fmtTok(p.input)+' \\u00b7 output '+fmtTok(p.output)+' \\u00b7 cached '+fmtTok(p.cached)+' \\u00b7 ~'+fmtCost(estCost(p.input,p.output,p.cached))+' API-equiv"><b>'+esc(p.phase)+'</b> '+fmtTok(p.total)+'</span>';}).join('')+'<span class="tktot">&Sigma; '+fmtTok(it.tokens.total)+(tinput?' &middot; <b style="color:#3fb27f">'+fmtTok(tcached)+' cached</b>':'')+' &middot; <span title="what this ticket would cost at GPT-5.5 API rates; actual spend is flat, not per-token">~'+fmtCost(mc)+' at API rates</span></span>';}
 else{tk.style.display='none';}
 const ma=document.getElementById('mactions');if(it){ma.style.display='flex';ma.innerHTML=actionList(it).map(function(d){return abtn(it.identifier,d)}).join('')+'<button class="mbtn mmore" data-id="'+it.identifier+'" onclick="colMenu(this,event)" title="move this ticket to any column">&#8943;</button>';}else{ma.style.display='none';ma.innerHTML='';}}
function skeletonHtml(){return '<div class="lg lg-skel"></div><div class="lg lg-skel s2"></div><div class="lg lg-skel s3"></div><div class="lg lg-skel s4"></div><div class="lg lg-skel s5"></div>';}
function openModal(id){if(logEs){try{logEs.close()}catch(e){}logEs=null;}if(_logPoll){clearInterval(_logPoll);_logPoll=null;}expandedId=id;chatPending=false;logCount=0;var modal=document.getElementById('modal');modal.style.display='flex';requestAnimationFrame(function(){if(expandedId===id)modal.classList.add('open');});var b=document.getElementById('logbody');if(logCache.has(id)){var cl=logCache.get(id);b.innerHTML=cl.length?cl.map(logHtml).join(''):'<div class="lg" style="color:var(--mut)">(no log yet)</div>';logCount=cl.length;b.scrollTop=b.scrollHeight;}else b.innerHTML=skeletonHtml();syncHead();startLogStream(id);}
function closeModal(){expandedId=null;if(logEs){try{logEs.close()}catch(e){}logEs=null;}if(_logPoll){clearInterval(_logPoll);_logPoll=null;}var modal=document.getElementById('modal');modal.classList.remove('open');setTimeout(function(){if(!expandedId)modal.style.display='none';},200);}
function startLogStream(id){if(typeof EventSource==='undefined'){_logPoll=setInterval(function(){if(expandedId===id)pullLog()},1000);pullLog();return;}try{logEs=new EventSource('/log-stream/'+encodeURIComponent(id));}catch(e){_logPoll=setInterval(function(){if(expandedId===id)pullLog()},1000);pullLog();return;}
 logEs.onmessage=function(e){if(expandedId!==id)return;var j;try{j=JSON.parse(e.data)}catch(x){return;}var b=document.getElementById('logbody');var atEnd=b.scrollTop+b.clientHeight>=b.scrollHeight-60;
  if(j.seed){var ls=j.lines||[];logCount=ls.length;logCache.set(id,ls);b.innerHTML=(ls.length?ls.map(logHtml).join(''):(chatPending?'':'<div class="lg" style="color:var(--mut)">(no log yet)</div>'))+(chatPending?dotsHtml('agent is responding&hellip;'):'');}
  else if(j.lines&&j.lines.length){logCount+=j.lines.length;var d=b.querySelector('.lg-typing');if(d)d.remove();var lv0=b.querySelector('.lg-live');if(lv0)lv0.remove();b.insertAdjacentHTML('beforeend',j.lines.map(logHtml).join(''));if(chatPending)b.insertAdjacentHTML('beforeend',dotsHtml('agent is responding&hellip;'));}
  else if('live' in j){var dt=b.querySelector('.lg-typing');if(dt)dt.remove();var lv=b.querySelector('.lg-live');if(!j.live){if(lv)lv.remove();}else{if(!lv){lv=document.createElement('div');lv.className='lg lg-live';b.appendChild(lv);}lv.innerHTML=esc(j.live)+'<span class="lg-cur"></span>';}}
  if(atEnd||chatPending||('live' in j))b.scrollTop=b.scrollHeight;};
 logEs.onerror=function(){if(logEs){try{logEs.close()}catch(e){}logEs=null;}if(expandedId===id&&!_logPoll){_logPoll=setInterval(function(){if(expandedId===id)pullLog()},1000);pullLog();}};}
async function postAction(btn,id,action,ev){if(ev){ev.stopPropagation();ev.preventDefault();}
 var box=btn&&btn.parentNode;if(box)box.querySelectorAll('button').forEach(function(x){x.classList.add('busy')});
 var revert=null;
 if(id==='__pause__'&&action==='toggle'){var was=snap.paused;snap.paused=!snap.paused;render();revert=function(){snap.paused=was;render();};}
 else if(action==='pause'){var rr=(snap.roles||[]).find(function(x){return x.name===id});if(rr){var wp=!!rr.paused;rr.paused=!rr.paused;lastDockSig='';renderDock();revert=function(){rr.paused=wp;lastDockSig='';renderDock();};}}
 else if(action.indexOf('move:')===0){var to=action.slice(5);optimisticOverrides[id]={state:to,expiresAt:Date.now()+5000};render();if(expandedId===id)syncHead();revert=function(){delete optimisticOverrides[id];render();if(expandedId===id)syncHead();};}
 var ok=false;
 try{var r=await (await fetch('/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,action:action})})).json();ok=!!(r&&r.ok);var sys=(id||'').indexOf('__')===0;showToast(ok?((sys?'':id+' &mdash; ')+(r.msg||'done')):('Failed: '+((r&&r.msg)||'error')),!ok);}catch(e){showToast('Action failed',true);}
 if(!ok&&revert)revert();
 if(box)box.querySelectorAll('button.busy').forEach(function(x){x.classList.remove('busy')});
 document.querySelectorAll('#mactions button.busy').forEach(function(x){x.classList.remove('busy')});
 if(typeof EventSource==='undefined'||_pollFallback)pull();}
function showToast(msg,isErr){var t=document.getElementById('toast');t.innerHTML=(isErr?'&#10007; ':'&#10003; ')+msg;t.classList.remove('show');void t.offsetWidth;t.className=(isErr?'err':'ok')+' show';clearTimeout(window._tt);window._tt=setTimeout(function(){t.className=isErr?'err':'ok'},3400);}
function modalAct(id,action,ev){var ma=document.getElementById('mactions');if(ma)ma.querySelectorAll('button').forEach(function(x){x.classList.add('busy')});postAction(null,id,action,ev);}
let menuFor=null;
function showMenu(btn,id,items){if(!items.length){closeMenu();return;}var m=document.getElementById('actmenu');
 m.innerHTML=items.map(function(d){return '<button class="actitem '+(d.c||'')+'" title="'+(d.t||'')+'" onclick="menuAction(\\''+id+'\\',\\''+d.a+'\\',event)">'+d.l+'</button>'}).join('');
 m.style.display='flex';m.style.visibility='hidden';
 var r=btn.getBoundingClientRect(),mw=m.offsetWidth,mh=m.offsetHeight;
 var left=Math.max(8,r.right-mw),top=r.bottom+5;if(top+mh>window.innerHeight-8)top=Math.max(8,r.top-mh-5);
 m.style.left=left+'px';m.style.top=top+'px';m.style.visibility='visible';menuFor=id;}
function toggleMenu(btn,ev){if(ev){ev.stopPropagation();ev.preventDefault();}var id=btn.getAttribute('data-id');if(menuFor===id){closeMenu();return;}var it=(snap.items||[]).find(function(x){return x.identifier===id});showMenu(btn,id,actionList(it).concat(moveItems(it)));}
function colMenu(btn,ev){if(ev){ev.stopPropagation();ev.preventDefault();}var id=btn.getAttribute('data-id');if(menuFor===id){closeMenu();return;}var it=(snap.items||[]).find(function(x){return x.identifier===id});showMenu(btn,id,moveItems(it));}
function menuAction(id,action,ev){if(ev){ev.stopPropagation();ev.preventDefault();}closeMenu();postAction(null,id,action);}
function closeMenu(){var m=document.getElementById('actmenu');m.style.display='none';m.innerHTML='';menuFor=null;}
document.addEventListener('click',function(e){if(!e.target.closest('#actmenu')&&!e.target.closest('.kebab'))closeMenu();});
window.addEventListener('scroll',closeMenu,true);window.addEventListener('resize',closeMenu);
board.addEventListener('click',function(e){const c=e.target.closest('[data-id]');if(!c)return;openModal(c.getAttribute('data-id'));});
document.getElementById('dock').addEventListener('click',function(e){const c=e.target.closest('[data-role]');if(!c)return;openModal(c.getAttribute('data-role'));});
document.getElementById('mclose').addEventListener('click',closeModal);
document.getElementById('modal').addEventListener('click',function(e){if(e.target.id==='modal')closeModal();});
document.addEventListener('keydown',function(e){
 var ae=document.activeElement||{};if(/^(TEXTAREA|INPUT)$/.test(ae.tagName||''))return;
 if(e.key==='Escape'){closeModal();return;}
 if(expandedId){if(e.key==='ArrowDown'||e.key==='ArrowUp'){var lb=document.getElementById('logbody');lb.scrollTop+=(e.key==='ArrowDown'?140:-140);e.preventDefault();}return;}
 if(e.key==='p'||e.key==='P'){var pb=document.getElementById('pausebtn');if(pb)pb.click();return;}
 if(e.key==='j'||e.key==='k'){var cards=[].slice.call(document.querySelectorAll('#board .card[data-id]'));if(!cards.length)return;var cur=ae.closest?ae.closest('.card'):null;var idx=cards.indexOf(cur);var nx=e.key==='j'?idx+1:idx-1;if(nx<0)nx=0;if(nx>=cards.length)nx=cards.length-1;cards.forEach(function(c){c.classList.remove('kbfocus')});var t=cards[nx];if(t){t.classList.add('kbfocus');t.focus();t.scrollIntoView({block:'nearest',inline:'nearest'});}e.preventDefault();return;}
 if(e.key==='Enter'){var f=ae.closest?ae.closest('.card[data-id]'):null;if(f){openModal(f.getAttribute('data-id'));e.preventDefault();}return;}
});
function logHtml(line){var t=(line||'').replace(/^\\n+/,'');
 if(t.indexOf('\\u2500\\u2500')===0)return '<div class="lg lg-turn">'+esc(t.replace(/\\u2500/g,'').trim())+'</div>';
 if(t.indexOf('\\u25cb ')===0)return '<div class="lg lg-op"><b>you</b>'+esc(t.slice(2))+'</div>';
 if(t.indexOf('\\u25cf ')===0)return '<div class="lg lg-msg">'+esc(t.slice(2))+'</div>';
 if(t.indexOf('$ ')===0){var c=esc(t.slice(2));return '<div class="lg lg-cmd" title="'+c.replace(/"/g,'&quot;')+'"><b>$</b>'+c+'</div>';}
 if(t.indexOf('\\u2699')===0)return '<div class="lg lg-tool">'+esc(t)+'</div>';
 if(t.indexOf('\\u270e')===0)return '<div class="lg lg-edit">'+esc(t)+'</div>';
 return '<div class="lg lg-cmd">'+esc(t)+'</div>';}
var chatPending=false;
function dotsHtml(label){return '<div class="lg lg-typing"><span class="tdots"><i class="tdot"></i><i class="tdot"></i><i class="tdot"></i></span>'+label+'</div>';}
async function pullLog(){if(!expandedId)return;var b=document.getElementById('logbody');try{const res=await fetch('/transcript/'+encodeURIComponent(expandedId),{cache:'no-store'});if(!res.ok){b.innerHTML='<div class="lg" style="color:#e0564f">transcript fetch failed ('+res.status+') &mdash; try reloading the page</div>';return;}if((res.headers.get('content-type')||'').indexOf('json')<0){b.innerHTML='<div class="lg" style="color:#e0564f">got a non-JSON response (session/proxy) &mdash; hard-reload the page</div>';return;}const j=await res.json();const atEnd=b.scrollTop+b.clientHeight>=b.scrollHeight-60;b.innerHTML=((j.log&&j.log.length)?j.log.map(logHtml).join(''):(chatPending?'':'<div class="lg" style="color:var(--mut)">(no log yet)</div>'))+(chatPending?dotsHtml('agent is responding&hellip;'):'');if(atEnd||chatPending)b.scrollTop=b.scrollHeight;}catch(e){b.innerHTML='<div class="lg" style="color:#e0564f">couldn\\'t load transcript: '+esc(String((e&&e.message)||e))+'</div>';}}
async function sendChat(){if(!expandedId)return;var box=document.getElementById('mmsg'),btn=document.getElementById('msend');var text=box.value.trim();if(!text)return;box.value='';box.style.height='auto';box.disabled=true;btn.disabled=true;btn.textContent='\\u2026';chatPending=true;var lb=document.getElementById('logbody');if(lb&&!lb.querySelector('.lg-typing')){lb.insertAdjacentHTML('beforeend',dotsHtml('agent is responding&hellip;'));lb.scrollTop=lb.scrollHeight;}try{var r=await (await fetch('/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:expandedId,text:text})})).json();if(!(r&&r.ok))showToast('Chat: '+((r&&r.msg)||'failed'),true);}catch(e){showToast('Chat failed',true);}chatPending=false;btn.disabled=false;box.disabled=false;btn.textContent='Send';var d=lb&&lb.querySelector('.lg-typing');if(d)d.remove();box.focus();}
function prefetchLog(id){if(!id||logCache.has(id))return;fetch('/transcript/'+encodeURIComponent(id),{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.log)logCache.set(id,j.log)}).catch(function(){});}
board.addEventListener('mouseover',function(e){var c=e.target.closest&&e.target.closest('[data-id]');if(c)prefetchLog(c.getAttribute('data-id'));});
document.getElementById('dock').addEventListener('mouseover',function(e){var c=e.target.closest&&e.target.closest('[data-role]');if(c)prefetchLog(c.getAttribute('data-role'));});
(function(){var mm=document.getElementById('mmsg'),ms=document.getElementById('msend');if(mm&&ms){ms.disabled=true;mm.addEventListener('input',function(){mm.style.height='auto';mm.style.height=Math.min(mm.scrollHeight,160)+'px';ms.disabled=!mm.value.trim();});}})();
function startSSE(){var es;try{es=new EventSource('/events');}catch(e){if(!_pollFallback)_pollFallback=setInterval(pull,1000);return;}
 es.onmessage=function(e){try{snap=JSON.parse(e.data);if(snap.columns&&snap.columns.length)COLS=snap.columns;}catch(x){}render();if(expandedId)syncHead();};
 es.onerror=function(){try{es.close()}catch(x){}if(!_pollFallback)_pollFallback=setInterval(pull,1000);setTimeout(function(){if(_pollFallback){clearInterval(_pollFallback);_pollFallback=null;}startSSE();},5000);};}
setInterval(tickLive,1000);
if(typeof EventSource!=='undefined')startSSE();else _pollFallback=setInterval(pull,1000);
pull();
</script></body></html>`

const STATS_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>bunion · stats</title>
<style>
*{box-sizing:border-box}
:root{--bg:#090a0e;--surf:#15171e;--surf2:#1b1e27;--line:#23262f;--line2:#2e323d;--fg:#eef1f7;--mut:#99a0ad;--mut2:#5a6270;--accent:#5b8def;--green:#3fb27f;--amber:#d99a2b;--red:#e0564f;--purple:#a371f7}
body{margin:0;min-height:100vh;background:var(--bg);background-image:radial-gradient(1100px 520px at 80% -10%,#14171f 0%,rgba(20,23,31,0) 60%),linear-gradient(180deg,#0b0d12 0%,#090a0e 100%);color:var(--fg);font:13.5px/1.5 -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased;padding:22px 26px 60px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:15px;font-weight:650;margin:0;display:flex;align-items:center;gap:11px}
.mark{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px #5b8def22,0 0 14px var(--accent)}
.back{color:var(--mut);font-weight:400;font-size:12.5px;margin-left:auto}
.tot{display:flex;gap:11px;flex-wrap:wrap;margin:18px 0 6px}
.tot .c{background:var(--surf);border:1px solid var(--line);border-radius:10px;padding:9px 16px;font-variant-numeric:tabular-nums;box-shadow:0 1px 2px rgba(0,0,0,.4)}
.tot .c b{font-size:19px;display:block;color:var(--fg);font-weight:650}.tot .c span{font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.6px}
h2{font-size:11px;letter-spacing:.7px;text-transform:uppercase;color:var(--mut);margin:30px 0 11px;font-weight:700}
.wrap{background:var(--surf);border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.4)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:right;padding:8px 14px;border-bottom:1px solid var(--line);white-space:nowrap}
tr:last-child td{border-bottom:none}
th:first-child,td:first-child{text-align:left}
th{color:var(--mut);font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;background:var(--surf2)}
th.s{cursor:pointer;user-select:none}th.s:hover{color:var(--fg)}
th.act{color:var(--accent)}th.act:after{content:' \\25be'}
tbody tr:hover{background:var(--surf2)}
.bar{display:inline-block;height:7px;border-radius:4px;background:var(--accent);vertical-align:middle;margin-left:7px;opacity:.6}
.out{font-size:10.5px;padding:2px 9px;border-radius:20px;font-weight:600}
.cid{font-family:ui-monospace,Menlo,monospace;font-weight:600}
.muted{color:var(--mut2)}
.tid{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--mut2)}
.acct{font-size:11px;color:var(--mut)}
.empty{color:var(--mut2);padding:22px;text-align:center}
</style></head><body>
<h1><span class="mark"></span>bunion <span class="muted">· stats</span><a class="back" href="/">&larr; board</a></h1>
<div class="tot" id="tot"></div>
<h2>last 30 days</h2><div class="wrap"><table id="daily"><thead><tr><th>day</th><th>dispatched</th><th>shipped</th><th>tokens</th><th>deadlocks</th><th>caps</th></tr></thead><tbody></tbody></table></div>
<h2>threads <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">&mdash; click a column to rank best/worst</span></h2><div class="wrap"><table id="th"><thead><tr><th>ticket</th><th>outcome</th><th class="s" data-k="tokens">tokens</th><th class="s" data-k="cycle_ms">cycle</th><th class="s" data-k="reworks">reworks</th><th class="s" data-k="caps">cap/dl</th><th>account</th><th>thread</th></tr></thead><tbody></tbody></table></div>
<script>
const fmtTok=n=>{n=n||0;return n>=1e9?(n/1e9).toFixed(2)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n)};
const dur=ms=>{ms=ms||0;let m=Math.round(ms/60000);if(m<60)return m+'m';let h=Math.floor(m/60);return h+'h'+(m%60?' '+(m%60)+'m':'')};
const esc=s=>(s||'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
const OC={'Done':'var(--purple)','STG - Ready to merge':'var(--green)','STG - Merged':'var(--amber)','Verifying in Prod':'var(--accent)','Needs Engineer':'#d9568c','QA blocked':'var(--red)'};
const oc=s=>OC[s]||'var(--mut2)';
const num=v=>typeof v==='number'?v:0;
let DATA=null,K='tokens',DIR=-1;
function thr(){const t=DATA.threads.slice().sort((a,b)=>{let x=a[K],y=b[K];return (typeof x==='string'?(x||'').localeCompare(y||''):num(x)-num(y))*DIR});
 document.querySelector('#th tbody').innerHTML=t.length?t.map(r=>'<tr><td><a class="cid" href="https://linear.app/bevyl/issue/'+esc(r.identifier)+'" target="_blank" rel="noopener">'+esc(r.identifier)+'</a></td><td style="text-align:right"><span class="out" style="background:'+oc(r.outcome)+'22;color:'+oc(r.outcome)+'">'+esc(r.outcome||'—')+'</span></td><td>'+fmtTok(r.tokens)+'</td><td>'+dur(r.cycle_ms)+'</td><td>'+(r.reworks||0)+'</td><td>'+(((r.caps||0)+(r.deadlocks||0))||'')+'</td><td class="acct">'+esc((r.account||'').replace(/ .*/,'')||'—')+'</td><td class="tid">'+esc((r.thread_id||'').slice(0,12)||'—')+'</td></tr>').join(''):'<tr><td colspan="8" class="empty">no threads recorded yet</td></tr>';
 document.querySelectorAll('#th th.s').forEach(h=>h.classList.toggle('act',h.dataset.k===K));}
function daily(){const d=DATA.daily,mx=Math.max(1,...d.map(x=>num(x.tokens)));
 document.querySelector('#daily tbody').innerHTML=d.length?d.map(r=>'<tr><td>'+esc(r.day)+'</td><td>'+(r.dispatched||0)+'</td><td style="color:var(--green)">'+(r.shipped||0)+'</td><td>'+fmtTok(r.tokens)+'<span class="bar" style="width:'+Math.round(num(r.tokens)/mx*70)+'px"></span></td><td'+(r.deadlocks?' style="color:var(--amber)"':'')+'>'+(r.deadlocks||0)+'</td><td'+(r.caps?' style="color:var(--red)"':'')+'>'+(r.caps||0)+'</td></tr>').join(''):'<tr><td colspan="6" class="empty">no activity recorded yet</td></tr>';}
function render(){const T=DATA.totals||{};document.getElementById('tot').innerHTML=[['tickets',T.tickets],['events',T.events],['deadlocks',T.deadlocks],['caps',T.caps]].map(p=>'<div class="c"><b>'+(p[1]||0)+'</b><span>'+p[0]+'</span></div>').join('');daily();thr();}
document.querySelectorAll('#th th.s').forEach(h=>h.onclick=()=>{const k=h.dataset.k;if(K===k)DIR=-DIR;else{K=k;DIR=-1}thr()});
fetch('/stats.json',{cache:'no-store'}).then(r=>r.json()).then(d=>{DATA=d;render()}).catch(e=>{document.body.insertAdjacentHTML('beforeend','<p style="color:var(--red)">failed to load stats: '+e+'</p>')});
</script></body></html>`
