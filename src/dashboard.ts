// One ticket on the board. `status`: running (an agent is on it now), retrying (waiting out a backoff/continuation),
// or queued (an eligible candidate with no free slot/VM yet). The run-specific fields are 0/empty unless running.
export interface BoardItem {
  identifier: string
  title: string
  state: string
  priority: number
  host: string | null
  status: 'running' | 'retrying' | 'queued'
  turn: number
  activity: string
  startedAt: number
  lastActivity: number
  retryAttempt: number
  retryDueAt: number | null
}

export interface Snapshot {
  scope: string
  cap: number
  pollMs: number
  now: number
  items: BoardItem[] // the WHOLE board (every active+labeled ticket), not just the running ones
  recent: { identifier: string; kind: string; at: number; detail: string | null }[]
}

// A tiny status server: GET /state.json is the live orchestrator snapshot; GET / is a self-contained page that
// polls it and renders the running grid + retry queue + recent outcomes.
export function startDashboard(port: number, getSnapshot: () => Snapshot, getLog: (id: string) => string[], log: (m: string) => void): void {
  Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/state.json') return Response.json(getSnapshot())
      if (url.pathname === '/log') return Response.json({ log: getLog(url.searchParams.get('id') ?? '') })
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
<div id="drawer" style="display:none;margin:0 22px 18px;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden">
 <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line)">
  <span id="drawerId" style="font-weight:700"></span>
  <span id="drawerClose" style="margin-left:auto;cursor:pointer;color:var(--mut)">close &#10005;</span>
 </div>
 <pre id="logbody" style="margin:0;padding:14px;max-height:360px;overflow:auto;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--fg)"></pre>
</div>
<div class="sec"><h2>recent</h2><div id="recent" class="muted">&mdash;</div></div>
<script>
const SC=s=>({'Todo':'#5b6b7f','In Progress':'#4a86c5','QA Requested':'#c9952b','QA testing started':'#c9952b','QA blocked':'#cf5a4f','Ready to ship':'#36a86a','Done':'#36a86a'}[s]||'#5b6b7f');
const ago=ms=>{let s=Math.max(0,Math.floor(ms/1000));if(s<60)return s+'s';let m=Math.floor(s/60);if(m<60)return m+'m '+(s%60)+'s';return Math.floor(m/60)+'h '+(m%60)+'m'};
const dur=ms=>{let s=Math.max(0,Math.floor(ms/1000)),m=Math.floor(s/60);return String(m).padStart(2,'0')+':'+String(s%60).padStart(2,'0')};
const esc=s=>(s||'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
let snap={items:[],recent:[],cap:0,scope:''};
async function pull(){try{snap=await (await fetch('/state.json')).json()}catch(e){}render()}
function render(){
 const now=Date.now();
 const items=snap.items||[];
 const run=items.filter(r=>r.status==='running').length,q=items.filter(r=>r.status==='queued').length,rt=items.filter(r=>r.status==='retrying').length;
 scope.textContent=snap.scope||'';
 count.textContent=run+' running'+(rt?' · '+rt+' retrying':'')+' · '+q+' queued · '+(snap.cap||0)+' cap';
 clock.textContent=new Date().toLocaleTimeString();
 grid.innerHTML=items.length?items.map(r=>{
  const c=SC(r.state),run=r.status==='running';
  const act=now-r.lastActivity,dc=act<30000?'#36a86a':act<120000?'#c9952b':'#cf5a4f';
  let foot;
  if(run) foot='<span class="muted"><span class="dot" style="background:'+dc+'"></span>active '+ago(act)+' ago</span>'+(r.host?'<span class="muted" style="max-width:48%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="'+esc(r.host)+'">&#9709; '+esc(r.host)+'</span>':'');
  else if(r.status==='retrying') foot='<span class="muted">&#8635; retry '+(r.retryDueAt?'in '+ago(r.retryDueAt-now):'soon')+(r.retryAttempt>0?' &middot; attempt '+r.retryAttempt:'')+'</span>';
  else foot='<span class="muted">&#9203; queued &middot; waiting for a slot</span>';
  return '<div class="card" data-id="'+r.identifier+'" style="cursor:pointer;opacity:'+(run?'1':'.62')+(r.identifier===expandedId?';outline:2px solid #4a86c5':'')+'"><div class="id">'+r.identifier+'</div>'+
   '<div class="title">'+esc(r.title)+'</div>'+
   '<div class="row"><span class="badge" style="background:'+c+'2a;color:'+c+'">'+esc(r.state)+'</span>'+(run?'<span class="t muted">&#9201; '+dur(now-r.startedAt)+'</span>':'')+'</div>'+
   (run?'<div class="row"><span class="muted" style="display:block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">turn '+(r.turn||0)+' &middot; '+esc((r.activity||'').slice(0,64))+'</span></div>':'')+
   '<div class="row">'+foot+'</div></div>'}).join(''):'<div class="empty">no '+esc(snap.scope||'dark-factory')+' tickets in scope</div>';
 recent.innerHTML=(snap.recent&&snap.recent.length)?snap.recent.map(x=>'<span class="pill">'+(x.kind==='failed'?'&#10007;':'&#10003;')+' '+x.identifier+' &middot; '+ago(now-x.at)+' ago</span>').join(''):'&mdash;';
}
let expandedId=null;
grid.addEventListener('click',e=>{const c=e.target.closest('[data-id]');if(!c)return;const id=c.getAttribute('data-id');expandedId=(expandedId===id)?null:id;syncDrawer();});
document.getElementById('drawerClose').addEventListener('click',()=>{expandedId=null;syncDrawer();});
function syncDrawer(){const d=document.getElementById('drawer');if(!expandedId){d.style.display='none';return;}d.style.display='block';document.getElementById('drawerId').textContent=expandedId+' — log';pullLog();}
async function pullLog(){if(!expandedId)return;try{const j=await (await fetch('/log?id='+encodeURIComponent(expandedId))).json();const b=document.getElementById('logbody');const atEnd=b.scrollTop+b.clientHeight>=b.scrollHeight-40;b.textContent=(j.log&&j.log.length)?j.log.join('\\n'):'(no log yet)';if(atEnd)b.scrollTop=b.scrollHeight;}catch(e){}}
setInterval(render,1000);setInterval(pull,2000);setInterval(pullLog,1500);pull();
</script></body></html>`
