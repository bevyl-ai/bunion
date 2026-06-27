export interface Snapshot {
  scope: string
  cap: number
  pollMs: number
  now: number
  running: { identifier: string; title: string; state: string; startedAt: number; lastActivity: number; retryAttempt: number }[]
  retrying: { identifier: string; attempt: number; dueAt: number }[]
  recent: { identifier: string; kind: string; at: number; detail: string | null }[]
}

// A tiny status server: GET /state.json is the live orchestrator snapshot; GET / is a self-contained page that
// polls it and renders the running grid + retry queue + recent outcomes.
export function startDashboard(port: number, getSnapshot: () => Snapshot, log: (m: string) => void): void {
  Bun.serve({
    port,
    fetch(req) {
      if (new URL(req.url).pathname === '/state.json') return Response.json(getSnapshot())
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    },
  })
  log(`dashboard on http://localhost:${port}`)
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>bunion factory</title>
<style>
:root{--bg:#0b0d10;--card:#14181d;--line:#222a31;--mut:#7c8896;--fg:#e6edf3}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
header{display:flex;align-items:center;gap:18px;padding:14px 22px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg)}
.b{font-weight:700;letter-spacing:.5px}.s{color:var(--mut)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px;padding:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:15px}
.id{font-size:18px;font-weight:700}.title{color:var(--mut);font-size:12px;margin:5px 0 12px;height:34px;overflow:hidden}
.row{display:flex;justify-content:space-between;align-items:center;margin-top:7px}
.badge{padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px;vertical-align:middle}
.t{font-variant-numeric:tabular-nums}.muted{color:var(--mut);font-size:12px}
.sec{padding:0 22px 18px}.sec h2{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:1.5px;margin:0 0 8px}
.pill{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:3px 11px;margin:3px 3px 0 0;font-size:12px}
.empty{color:var(--mut);padding:48px;text-align:center;grid-column:1/-1}
</style></head><body>
<header><span class="b">&#9679; bunion</span><span class="s" id="scope"></span><span class="s" id="count"></span><span class="s" style="margin-left:auto" id="clock"></span></header>
<div class="grid" id="grid"></div>
<div class="sec"><h2>retry queue</h2><div id="retry" class="muted">&mdash;</div></div>
<div class="sec"><h2>recent</h2><div id="recent" class="muted">&mdash;</div></div>
<script>
const SC=s=>({'Todo':'#5b6b7f','In Progress':'#4a86c5','QA Requested':'#c9952b','QA testing started':'#c9952b','QA blocked':'#cf5a4f','Ready to ship':'#36a86a','Done':'#36a86a'}[s]||'#5b6b7f');
const ago=ms=>{let s=Math.max(0,Math.floor(ms/1000));if(s<60)return s+'s';let m=Math.floor(s/60);if(m<60)return m+'m '+(s%60)+'s';return Math.floor(m/60)+'h '+(m%60)+'m'};
const dur=ms=>{let s=Math.max(0,Math.floor(ms/1000)),m=Math.floor(s/60);return String(m).padStart(2,'0')+':'+String(s%60).padStart(2,'0')};
const esc=s=>(s||'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
let snap={running:[],retrying:[],recent:[],cap:0,scope:''};
async function pull(){try{snap=await (await fetch('/state.json')).json()}catch(e){}render()}
function render(){
 const now=Date.now();
 scope.textContent=snap.scope||'';count.textContent=(snap.running?.length||0)+' / '+(snap.cap||0)+' running';
 clock.textContent=new Date().toLocaleTimeString();
 grid.innerHTML=(snap.running&&snap.running.length)?snap.running.map(r=>{
  const act=now-r.lastActivity,dc=act<30000?'#36a86a':act<120000?'#c9952b':'#cf5a4f',c=SC(r.state);
  return '<div class="card"><div class="id">'+r.identifier+(r.retryAttempt>0?' <span class="badge" style="background:#3a2b2b;color:#d9a">retry '+r.retryAttempt+'</span>':'')+'</div>'+
   '<div class="title">'+esc(r.title)+'</div>'+
   '<div class="row"><span class="badge" style="background:'+c+'2a;color:'+c+'">'+esc(r.state)+'</span><span class="t muted">&#9201; '+dur(now-r.startedAt)+'</span></div>'+
   '<div class="row"><span class="muted"><span class="dot" style="background:'+dc+'"></span>active '+ago(act)+' ago</span></div></div>'}).join(''):'<div class="empty">idle &mdash; no runs in flight</div>';
 retry.innerHTML=(snap.retrying&&snap.retrying.length)?snap.retrying.map(x=>'<span class="pill">'+x.identifier+' &middot; attempt '+x.attempt+' &middot; in '+ago(x.dueAt-now)+'</span>').join(''):'&mdash;';
 recent.innerHTML=(snap.recent&&snap.recent.length)?snap.recent.map(x=>'<span class="pill">'+(x.kind==='failed'?'&#10007;':'&#10003;')+' '+x.identifier+' &middot; '+ago(now-x.at)+' ago</span>').join(''):'&mdash;';
}
setInterval(render,1000);setInterval(pull,2000);pull();
</script></body></html>`
