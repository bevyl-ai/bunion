import type { TokenBreakdown } from './tokens'

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
}

export interface Snapshot {
  scope: string
  cap: number
  items: BoardItem[] // the WHOLE board (every active+labeled ticket), not just the running ones
  totalTokens: number // all-time tokens across every tracked ticket (bunion runs on one account: chatgpt-4)
  totalInput: number
  totalOutput: number
  totalCached: number // cache-hit input tokens — the cheap part; cached/input is the hit rate
  paused: boolean // operator panic switch — when true, dispatch is halted (daemon + dashboard stay up)
  roles: RoleItem[] // the pool — ambient roles rendered in the bottom dock
}

// A tiny status server: GET /state.json is the live orchestrator snapshot; GET / is a self-contained page that
// polls it and renders the board (kanban by pipeline stage) + a per-run log modal.
export function startDashboard(port: number, getSnapshot: () => Snapshot, getLog: (id: string) => string[], log: (m: string) => void, onAction?: (id: string, action: string) => Promise<{ ok: boolean; msg?: string }>, onChat?: (id: string, text: string) => Promise<{ ok: boolean; reply?: string; msg?: string }>): void {
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const noStore = { headers: { 'cache-control': 'no-store' } }
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
        return Response.json(await onAction(body.id, body.action))
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
.clock{margin-left:auto;color:var(--mut2);font-size:12px;font-variant-numeric:tabular-nums;font-family:ui-monospace,Menlo,monospace}
.pausebtn{margin-left:12px;background:#15171e;border:1px solid #4a3a1a;color:#d99a2b;border-radius:8px;padding:5px 13px;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:.2px;transition:background .15s,border-color .15s;white-space:nowrap}
.pausebtn:hover{background:#1d1810;border-color:#d99a2b}
.pausebtn.on{background:#11201a;border-color:#3fb27f;color:#3fb27f}
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
.cacts{display:flex;gap:6px;margin-top:10px}
.cbtn{flex:1;min-width:0;font:600 11px/1 inherit;color:var(--fg);background:var(--surf2);border:1px solid var(--line2);border-radius:7px;padding:6px 8px;cursor:pointer;transition:background .12s,border-color .12s;white-space:nowrap}
.cbtn:hover{background:#2a2f3a;border-color:#3a4150}
.cbtn.go{color:#9ec1ff;border-color:#5b8def44}.cbtn.go:hover{background:#5b8def1f}
.cbtn.warn{color:#d9a62b;border-color:#d9a62b44}.cbtn.warn:hover{background:#d9a62b1a}
.cbtn.danger{color:#eaa6a0;border-color:#e0564f44}.cbtn.danger:hover{background:#e0564f1a}
.cbtn.busy{opacity:.5;pointer-events:none}
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
</style></head><body>
<header>
 <div class="brand"><span class="mark"></span>bunion<span class="sub" id="scope"></span></div>
 <div class="stats" id="stats"></div>
 <span class="clock" id="clock"></span>
 <button id="pausebtn" class="pausebtn" onclick="postAction(this,'__pause__','toggle',event)">&#9208; Pause</button>
</header>
<div id="pausebanner"></div>
<div class="board" id="board"></div>
<div id="dock"></div>
<div id="modal"><div id="mpanel">
 <div id="mhead"><span class="live"></span><span id="mtitle"></span><span id="mclose">close &#10005;</span></div>
 <div id="msub"></div>
 <div id="mbanner" style="display:none"></div>
 <div id="mtokens" style="display:none"></div>
 <div id="logbody"></div>
 <div id="mchat"><textarea id="mmsg" rows="1" placeholder="Message the agent — it answers with this ticket's full thread as context" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat();}"></textarea><button id="msend" onclick="sendChat()">Send</button></div>
 <div id="mactions"></div>
</div></div>
<div id="actmenu"></div>
<div id="toast"></div>
<script>
const SC=s=>({'Triage':'#7c8493','Backlog':'#7c8493','Todo':'#7c8493','In Progress':'#5b8def','QA Requested':'#d99a2b','QA Verify':'#c79a3a','QA blocked':'#e0564f','Needs human':'#d9568c','Ready to ship':'#3fb27f','Done':'#a371f7'}[s]||'#7c8493');
const ago=ms=>{let s=Math.max(0,Math.floor(ms/1000));if(s<60)return s+'s';let m=Math.floor(s/60);if(m<60)return m+'m '+(s%60)+'s';return Math.floor(m/60)+'h '+(m%60)+'m'};
const dur=ms=>{let s=Math.max(0,Math.floor(ms/1000)),m=Math.floor(s/60);return String(m).padStart(2,'0')+':'+String(s%60).padStart(2,'0')};
const esc=s=>(s||'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
const fmtTok=n=>{n=n||0;return n>=1e9?(n/1e9).toFixed(2)+'B':n>=1e6?(n/1e6).toFixed(n>=1e8?0:1)+'M':n>=1e4?Math.round(n/1e3)+'k':n>=1e3?(n/1e3).toFixed(1)+'k':String(n)};
// API-equivalent $ at ~GPT-5 rates ($ per 1M tokens). Actual spend is the flat $200/mo Pro plan — this is the would-be cost / value extracted, not what you pay. Tweak the rates if the model differs.
var COST_IN=5,COST_CACHED=0.5,COST_OUT=30,PLAN_MONTHLY=200;
function estCost(input,output,cached){var unc=Math.max(0,(input||0)-(cached||0));return (unc*COST_IN+(cached||0)*COST_CACHED+(output||0)*COST_OUT)/1e6;}
function fmtCost(d){return d>=100?'$'+Math.round(d):d>=1?'$'+d.toFixed(1):'$'+d.toFixed(2);}
// What the same compute costs on the flat plan. A $200/mo ChatGPT Pro (20x) plan is worth up to ~$14k/mo of
// API-equivalent usage if fully consumed (tbreak / SemiAnalysis), so the plan prices compute at ~$200/$14000 of API.
var PLAN_API_VALUE=14000;
function planCost(input,output,cached){return estCost(input,output,cached)*PLAN_MONTHLY/PLAN_API_VALUE;}
const PRI={1:'Urgent',2:'High',3:'Medium',4:'Low'};
var A_REWORK={a:'to-build',l:'Send to coding',c:'',t:'Move to In Progress so a fresh agent (re)writes the code and updates the PR'};
function actionList(it){if(!it||it.state==='Done')return [];
 if(it.status==='running')return [{a:'restart',l:'Restart this agent',c:'danger',t:'Stop the current agent, wipe its workspace, and re-run this phase from scratch'},A_REWORK];
 if(it.state==='Needs human')return [{a:'to-qa',l:'Re-run QA',c:'go',t:'Send back to QA Requested to re-verify'},A_REWORK];
 if(it.state==='Ready to ship')return [{a:'to-qa',l:'Re-verify before ship',c:'go',t:'Send back through QA before it ships'},A_REWORK];
 return [{a:'to-qa',l:'Run QA on it',c:'go',t:'Move to QA Requested and verify with a fresh QA agent'},A_REWORK];}
function abtn(id,d){return '<button class="mbtn '+(d.c||'')+'" title="'+(d.t||'')+'" onclick="modalAct(\\''+id+'\\',\\''+d.a+'\\',event)">'+d.l+'</button>';}
function kebab(it){return actionList(it).length?'<button class="kebab" data-id="'+it.identifier+'" onclick="toggleMenu(this,event)" title="actions">&#8943;</button>':'';}
const COLS=[
 {name:'Planning',c:'#8b93a1',states:['Triage','Backlog','Todo']},
 {name:'In Progress',c:'#5b8def',states:['In Progress']},
 {name:'QA check',c:'#d99a2b',states:['QA Requested']},
 {name:'Verify QA',c:'#c79a3a',states:['QA Verify']},
 {name:'Unblocking',c:'#e0564f',states:['QA blocked']},
 {name:'Needs human',c:'#d9568c',states:['Needs human']},
 {name:'Ready',c:'#3fb27f',states:['Ready to ship']},
 {name:'In Staging',c:'#e3b341',states:['Merged: In Staging']},
 {name:'Verifying prod',c:'#4a9eda',states:['Verifying in Prod']},
 {name:'Done',c:'#6b7280',states:['Done']}];
function colIdx(st){var l=(st||'').trim().toLowerCase();for(var i=0;i<COLS.length;i++)for(var j=0;j<COLS[i].states.length;j++)if(COLS[i].states[j].toLowerCase()===l)return i;return -1;}
function moveItems(it){if(!it)return [];var cur=colIdx(it.state);return COLS.map(function(col,i){return i===cur?null:{a:'move:'+col.states[0],l:'\\u2192 '+col.name,c:'',t:'Move this ticket to '+col.name};}).filter(Boolean);}
let snap={items:[],cap:0,scope:''};
async function pull(){try{snap=await (await fetch('/state.json',{cache:'no-store'})).json()}catch(e){}render()}
function cardHtml(r,now){
 const run=r.status==='running';
 const act=now-r.lastActivity,dc=act<30000?'#3fb27f':act<120000?'#d99a2b':'#e0564f';
 const pr=r.prUrl?'<a class="pr" href="'+r.prUrl+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">#'+(r.prUrl.split("/pull/")[1]||"")+'</a>':'';
 let status;
 if(run) status='<span class="ag t-ago"><i class="dot" style="background:'+dc+'"></i>active '+ago(act)+'</span>';
 else if(r.status==='retrying') status='<span class="ag">&#8635; retry '+(r.retryDueAt?'in '+ago(r.retryDueAt-now):'soon')+'</span>';
 else if(r.state==='Needs human') status='<span class="ag" style="color:#d9568c">&#9888; needs human</span>';
 else if(r.state==='Done') status='<span class="ag" style="color:#a371f7">&#10004; merged</span>';
 else if(r.state==='Ready to ship') status='<span class="ag" style="color:#3fb27f">&#10004; ready</span>';
 else if(r.status==='handoff') status='<span class="ag">&#10004; in review</span>';
 else status='<span class="ag">&#9203; queued</span>';
 const tot=r.enteredAt?'<span class="t-tot clk" title="total time in the factory">&#9201; '+ago((r.endedAt||now)-r.enteredAt)+'</span>':'';
 const tcst=r.tokens?estCost(r.tokens.phases.reduce(function(a,p){return a+p.input},0),r.tokens.phases.reduce(function(a,p){return a+p.output},0),r.tokens.phases.reduce(function(a,p){return a+p.cached},0)):0;
 const tk=r.tokens?'<span class="t-tok clk" title="'+fmtTok(r.tokens.total)+' tokens &middot; ~'+fmtCost(tcst)+' at API rates ($200/mo flat actual)">'+fmtTok(r.tokens.total)+' tok</span>':'<span class="t-tok"></span>';
 const pdot=(r.priority>=1&&r.priority<=4)?'<i class="pri p'+r.priority+'" title="'+PRI[r.priority]+' priority"></i>':'';
 const reason=((r.state==='QA blocked'||r.state==='Needs human')&&r.note)?'<div class="creason" title="why it is stuck">'+esc(r.note.slice(0,160))+'</div>':'';
 return '<div class="card'+(run?' run':'')+'" data-id="'+r.identifier+'">'+
  '<div class="ctop"><span class="cid">'+pdot+r.identifier+'</span><span class="ctr">'+pr+kebab(r)+'</span></div>'+
  '<div class="ctitle">'+esc(r.title)+'</div>'+
  (run?'<div class="cact t-act">turn '+(r.turn||0)+' &middot; '+esc((r.activity||'').slice(0,70))+'</div>':'')+
  reason+
  '<div class="cfoot">'+status+'<span class="meta">'+tk+tot+'</span></div>'+
 '</div>';
}
function colHtml(col,arr,now){return '<div class="col"><div class="colh"><i style="background:'+col.c+'"></i>'+col.name+'<span class="ct">'+arr.length+'</span></div><div class="colcards">'+(arr.length?arr.map(r=>cardHtml(r,now)).join(''):'<div class="colempty">empty</div>')+'</div></div>';}
let lastSig='';
function render(){
 const items=snap.items||[];
 const run=items.filter(r=>r.status==='running').length,q=items.filter(r=>r.status==='queued').length,rt=items.filter(r=>r.status==='retrying').length;
 scope.textContent=snap.scope||'';
 var pb=document.getElementById('pausebtn'),pbn=document.getElementById('pausebanner');if(pb){if(snap.paused){pb.className='pausebtn on';pb.innerHTML='&#9654; Resume';pbn.className='show';pbn.innerHTML='<span class="pb-dot"></span><b>FACTORY PAUSED</b> &middot; dispatch halted, agents stopped &mdash; click Resume to continue';}else{pb.className='pausebtn';pb.innerHTML='&#9208; Pause';pbn.className='';}}
 const chip=(col,n,lab)=>'<span class="chip"><i style="background:'+col+'"></i>'+n+' '+lab+'</span>';
 stats.innerHTML=chip('#3fb27f',run,'running')+(q?chip('#7c8493',q,'queued'):'')+(rt?chip('#d99a2b',rt,'retrying'):'')+'<span class="cap">'+(snap.cap||0)+' slots</span>'+(snap.totalTokens?'<span class="cap" title="~'+fmtCost(estCost(snap.totalInput,snap.totalOutput,snap.totalCached))+' at GPT-5.5 API rates &mdash; but actual spend is the flat $200/mo Pro plan, so this is the value extracted, not what you pay ('+fmtTok(snap.totalCached||0)+' of '+fmtTok(snap.totalInput||0)+' input cached)">&#931; '+fmtTok(snap.totalTokens)+' tok'+(snap.totalInput?' &middot; <b style="color:#3fb27f">'+Math.round(snap.totalCached/snap.totalInput*100)+'% cached</b>':'')+' &middot; <span title="At GPT-5.5 API rates this volume would cost ~'+fmtCost(estCost(snap.totalInput,snap.totalOutput,snap.totalCached))+'. A $'+PLAN_MONTHLY+'/mo Pro plan is worth up to ~$'+Math.round(PLAN_API_VALUE/1000)+'k/mo in API terms, so the same compute on the plan is ~'+fmtCost(planCost(snap.totalInput,snap.totalOutput,snap.totalCached))+' &mdash; about 1/'+Math.round(PLAN_API_VALUE/PLAN_MONTHLY)+'th of API, and what you actually pay.">~'+fmtCost(estCost(snap.totalInput,snap.totalOutput,snap.totalCached))+' api &middot; ~'+fmtCost(planCost(snap.totalInput,snap.totalOutput,snap.totalCached))+' on plan</span></span>':'');
 // Rebuild the board ONLY when structure changes (membership / state / status / pr); live fields tick in place.
 const sig=JSON.stringify(items.map(r=>[r.identifier,r.state,r.status,r.host,r.prUrl,r.retryAttempt,r.state==='QA blocked'?(r.note||''):'']));
 if(sig!==lastSig){
  lastSig=sig;const now=Date.now();
  if(!items.length){board.innerHTML='<div class="empty">no '+esc(snap.scope||'dark-factory')+' tickets in scope</div>';}
  else{
   const bk=COLS.map(()=>[]);
   for(const r of items){const i=colIdx(r.state);if(i>=0)bk[i].push(r);}  // post-merge states (In Staging/Verifying/Done) own columns; anything unmapped is skipped
   board.innerHTML=COLS.map((col,i)=>colHtml(col,bk[i],now)).join('');
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
function roleColor(n){n=(n||'').toLowerCase();return n==='mechanic'?'#d99a2b':n==='dreamer'?'#b88cd9':'#5b8def';}
function roleCard(r){var live=r.status==='running',col=roleColor(r.name),dc=live?'#3fb27f':'var(--mut2)';
 var capped=r.maxPerDay!=null&&r.filedToday>=r.maxPerDay;
 var stat=live?'working':(capped?'capped today':(r.lastRunAt?'last run '+ago(Date.now()-r.lastRunAt)+' ago':'idle'));
 var act=live?esc((r.activity||'working\\u2026').slice(0,120)):'<span style="color:var(--mut2)">'+(capped?'daily cap reached &middot; resumes at UTC midnight':'waiting for next run')+'</span>';
 return '<div class="rcard" data-role="'+esc(r.name)+'" style="border-left-color:'+col+'"><div class="rtop"><span class="rname" style="color:'+col+'">'+esc(r.name)+'</span>'+(r.model?'<span class="rmodel">'+esc(r.model)+'</span>':'')+'<span class="rstat"><i class="dot" style="background:'+dc+'"></i>'+stat+'</span></div><div class="ract">'+act+'</div><div class="rfoot">&#8635; every '+ago(r.cadenceMs)+(r.maxPerDay!=null?' &middot; <span style="color:'+(capped?'#d99a2b':'var(--mut2)')+'">'+r.filedToday+'/'+r.maxPerDay+' today</span>':'')+(r.tokens?' &middot; &#931; '+fmtTok(r.tokens)+' tok':'')+(r.host?' &middot; '+esc(r.host.replace(/\\.exe\\.xyz$/,'')):'')+'</div></div>';}
function renderDock(){var d=document.getElementById('dock');var roles=(snap.roles||[]);if(!roles.length){d.style.display='none';d.innerHTML='';return;}d.style.display='block';d.innerHTML='<div class="docklab">&#9670; the pool &middot; always-on</div><div class="dockrow">'+roles.map(roleCard).join('')+'</div>';}
function renderRoleHead(r){var live=r.status==='running';
 document.getElementById('mtitle').innerHTML='<span style="text-transform:capitalize;color:'+roleColor(r.name)+'">'+esc(r.name)+'</span> <span class="pill" style="color:var(--mut);background:#8b929e1a">pool role</span>'+(r.model?' <span class="pill" style="color:var(--mut2);background:#8b929e14;font-family:ui-monospace,Menlo,monospace">'+esc(r.model)+'</span>':'');
 var meta=['<span class="m">'+(live?'<i class="dot" style="background:#3fb27f"></i>working':'<i class="dot" style="background:var(--mut2)"></i>idle')+'</span>','<span class="m">&#8635; every '+ago(r.cadenceMs)+'</span>'];
 if(r.maxPerDay!=null)meta.push('<span class="m">'+r.filedToday+'/'+r.maxPerDay+' filed today</span>');
 if(r.lastRunAt)meta.push('<span class="m">last run '+ago(Date.now()-r.lastRunAt)+' ago</span>');
 if(r.tokens)meta.push('<span class="m">&#931; '+fmtTok(r.tokens)+' tok</span>');
 if(r.host)meta.push('<span class="m">&#9709; '+esc(r.host.replace(/\\.exe\\.xyz$/,''))+'</span>');
 document.getElementById('msub').innerHTML='<div class="mtitle2">'+(live?esc(r.activity||'working\\u2026'):'idle \\u2014 waiting for the next run')+'</div><div class="mmeta">'+meta.join('')+'</div>';
 document.getElementById('mbanner').style.display='none';document.getElementById('mtokens').style.display='none';document.getElementById('mactions').style.display='none';document.getElementById('mchat').style.display='flex';document.getElementById('mmsg').placeholder='Prompt '+r.name+' \\u2014 steer it; it acts on its next run';}
let expandedId=null;
function syncHead(){var role=(snap.roles||[]).find(x=>x.name===expandedId);if(role){renderRoleHead(role);return;}document.getElementById('mchat').style.display='flex';document.getElementById('mmsg').placeholder='Message the agent \\u2014 it answers with this ticket\\u2019s full thread as context';const it=(snap.items||[]).find(x=>x.identifier===expandedId);const c=it?SC(it.state):'#7c8493';
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
 if(it&&it.state==='Needs human'){ban.style.display='block';ban.className='nh';ban.innerHTML='<b>&#9888; Needs human</b> &mdash; '+(it.note?esc(it.note):'open the workpad in Linear for the decision needed');}
 else if(it&&it.note&&it.status!=='running'){ban.style.display='block';ban.className='note';ban.innerHTML=esc(it.note);}
 else{ban.style.display='none';}
 const tk=document.getElementById('mtokens');
 if(it&&it.tokens){var tcached=0,tinput=0,toutput=0;it.tokens.phases.forEach(function(p){tcached+=p.cached;tinput+=p.input;toutput+=p.output});var mc=estCost(tinput,toutput,tcached);tk.style.display='flex';tk.innerHTML='<span class="tklab">tokens</span>'+it.tokens.phases.map(function(p){return '<span class="tkph" title="input '+fmtTok(p.input)+' \\u00b7 output '+fmtTok(p.output)+' \\u00b7 cached '+fmtTok(p.cached)+' \\u00b7 ~'+fmtCost(estCost(p.input,p.output,p.cached))+' API-equiv"><b>'+esc(p.phase)+'</b> '+fmtTok(p.total)+'</span>';}).join('')+'<span class="tktot">&Sigma; '+fmtTok(it.tokens.total)+(tinput?' &middot; <b style="color:#3fb27f">'+fmtTok(tcached)+' cached</b>':'')+' &middot; <span title="at GPT-5.5 API rates vs the same compute on your $'+PLAN_MONTHLY+'/mo plan (~1/'+Math.round(PLAN_API_VALUE/PLAN_MONTHLY)+'th of API)">~'+fmtCost(mc)+' api &middot; ~'+fmtCost(planCost(tinput,toutput,tcached))+' on plan</span></span>';}
 else{tk.style.display='none';}
 const ma=document.getElementById('mactions');if(it){ma.style.display='flex';ma.innerHTML=actionList(it).map(function(d){return abtn(it.identifier,d)}).join('')+'<button class="mbtn mmore" data-id="'+it.identifier+'" onclick="colMenu(this,event)" title="move this ticket to any column">&#8943;</button>';}else{ma.style.display='none';ma.innerHTML='';}}
function openModal(id){expandedId=id;chatPending=false;document.getElementById('modal').style.display='flex';document.getElementById('logbody').innerHTML=dotsHtml('loading transcript&hellip;');syncHead();pullLog();}
function closeModal(){expandedId=null;document.getElementById('modal').style.display='none';}
async function postAction(btn,id,action,ev){if(ev){ev.stopPropagation();ev.preventDefault();}
 var box=btn&&btn.parentNode;if(box)box.querySelectorAll('button').forEach(function(x){x.classList.add('busy')});
 try{var r=await (await fetch('/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,action:action})})).json();var sys=(id||'').indexOf('__')===0;showToast((r&&r.ok)?((sys?'':id+' &mdash; ')+(r.msg||'done')):('Failed: '+((r&&r.msg)||'error')),!(r&&r.ok));}catch(e){showToast('Action failed',true);}
 setTimeout(pull,400);setTimeout(pull,1600);}
function showToast(msg,isErr){var t=document.getElementById('toast');t.innerHTML=(isErr?'&#10007; ':'&#10003; ')+msg;t.className=(isErr?'err':'ok')+' show';clearTimeout(window._tt);window._tt=setTimeout(function(){t.className=isErr?'err':'ok'},3400);}
function modalAct(id,action,ev){postAction(null,id,action,ev);}
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
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeModal();});
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
async function sendChat(){if(!expandedId)return;var box=document.getElementById('mmsg'),btn=document.getElementById('msend');var text=box.value.trim();if(!text)return;box.value='';box.disabled=true;btn.disabled=true;btn.textContent='\\u2026';chatPending=true;pullLog();try{var r=await (await fetch('/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:expandedId,text:text})})).json();if(!(r&&r.ok))showToast('Chat: '+((r&&r.msg)||'failed'),true);}catch(e){showToast('Chat failed',true);}chatPending=false;box.disabled=false;btn.disabled=false;btn.textContent='Send';pullLog();box.focus();}
setInterval(pull,1000);setInterval(tickLive,1000);setInterval(function(){if(expandedId){pullLog();syncHead();}},1000);pull();
</script></body></html>`
