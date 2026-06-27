// One ticket on the board. `status`: running (an agent is on it now), retrying (waiting out a backoff/continuation),
// or queued (an eligible candidate with no free slot/VM yet). The run-specific fields are 0/empty unless running.
export interface BoardItem {
  identifier: string
  title: string
  state: string
  priority: number
  host: string | null
  prUrl: string | null
  status: 'running' | 'retrying' | 'queued' | 'handoff' // handoff = left the active states (e.g. in QA), bunion is done with it for now
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
}

// A tiny status server: GET /state.json is the live orchestrator snapshot; GET / is a self-contained page that
// polls it and renders the board (kanban by pipeline stage) + a per-run log drawer.
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
.board{display:flex;gap:14px;padding:18px 22px;align-items:flex-start;overflow-x:auto}
.col{flex:1 1 0;min-width:240px;display:flex;flex-direction:column;gap:10px}
.colh{display:flex;align-items:center;gap:8px;padding:2px 2px 6px;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:var(--mut)}
.colh .ct{margin-left:auto;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:0 8px;color:var(--fg);font-weight:600}
.colempty{color:var(--mut);font-size:12px;padding:16px;text-align:center;border:1px dashed var(--line);border-radius:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 14px}
.id{font-size:18px;font-weight:700}.title{color:var(--mut);font-size:12px;margin:5px 0 12px;height:34px;overflow:hidden}
.row{display:flex;justify-content:space-between;align-items:center;margin-top:7px}
.badge{padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px;vertical-align:middle}
.t{font-variant-numeric:tabular-nums}.muted{color:var(--mut);font-size:12px}
.sec{padding:0 22px 18px}.sec h2{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:1.5px;margin:0 0 8px}
.pill{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:3px 11px;margin:3px 3px 0 0;font-size:12px}
.empty{color:var(--mut);padding:48px;text-align:center}
#drawer{margin:0 22px 18px;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
#dhead{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--line);font-size:13px}
#logbody{margin:0;padding:6px 14px 12px;max-height:60vh;overflow:auto;font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}
.lg{padding:.5px 0;white-space:pre-wrap;word-break:break-word}
.lg-turn{margin:12px 0 5px;color:#6aa3da;font-weight:700;border-top:1px solid var(--line);padding-top:9px;letter-spacing:.5px}
.lg-msg{color:var(--fg)}.lg-msg b{color:#46c08a;font-weight:700}
.lg-cmd{color:#8b97a4}.lg-cmd b{color:#46c08a}
.lg-tool{color:#c9952b}.lg-edit{color:#b88cd9}
.live{width:7px;height:7px;border-radius:50%;background:#36a86a;display:inline-block;animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
</style></head><body>
<header><span class="b">&#9679; bunion</span><span class="s" id="scope"></span><span class="s" id="count"></span><span class="s" style="margin-left:auto" id="clock"></span></header>
<div class="board" id="board"></div>
<div id="drawer" style="display:none">
 <div id="dhead">
  <span class="live"></span><span id="drawerId" style="font-weight:700"></span>
  <span id="drawerClose" style="margin-left:auto;cursor:pointer;color:var(--mut)">close &#10005;</span>
 </div>
 <div id="logbody"></div>
</div>
<script>
const SC=s=>({'Todo':'#5b6b7f','In Progress':'#4a86c5','QA Requested':'#c9952b','QA testing started':'#c9952b','QA blocked':'#cf5a4f','Ready to ship':'#36a86a','Done':'#36a86a'}[s]||'#5b6b7f');
const ago=ms=>{let s=Math.max(0,Math.floor(ms/1000));if(s<60)return s+'s';let m=Math.floor(s/60);if(m<60)return m+'m '+(s%60)+'s';return Math.floor(m/60)+'h '+(m%60)+'m'};
const dur=ms=>{let s=Math.max(0,Math.floor(ms/1000)),m=Math.floor(s/60);return String(m).padStart(2,'0')+':'+String(s%60).padStart(2,'0')};
const esc=s=>(s||'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
let snap={items:[],cap:0,scope:''};
async function pull(){try{snap=await (await fetch('/state.json')).json()}catch(e){}render()}
const COLS=[
 {name:'Plan',states:['Triage','Backlog','Todo']},
 {name:'Build',states:['In Progress','QA blocked']},
 {name:'QA',states:['QA Requested','QA testing started']},
 {name:'Ready to ship',states:['Ready to ship']}];
function colIdx(st){for(var i=0;i<COLS.length;i++)if(COLS[i].states.indexOf(st)>=0)return i;return -1;}
function cardHtml(r,now){
 const c=SC(r.state),run=r.status==='running';
 const act=now-r.lastActivity,dc=act<30000?'#36a86a':act<120000?'#c9952b':'#cf5a4f';
 let foot;
 if(run) foot='<span class="muted"><span class="dot" style="background:'+dc+'"></span>active '+ago(act)+' ago</span>'+(r.host?'<span class="muted" style="max-width:50%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="'+esc(r.host)+'">&#9709; '+esc(r.host.replace(/\\.exe\\.xyz$/,''))+'</span>':'');
 else if(r.status==='retrying') foot='<span class="muted">&#8635; retry '+(r.retryDueAt?'in '+ago(r.retryDueAt-now):'soon')+(r.retryAttempt>0?' &middot; #'+r.retryAttempt:'')+'</span>';
 else if(r.state==='Ready to ship') foot='<span class="muted">&#10004; awaiting human merge</span>';
 else if(r.status==='handoff') foot='<span class="muted">&#10004; handed off</span>';
 else foot='<span class="muted">&#9203; queued</span>';
 return '<div class="card" data-id="'+r.identifier+'" style="cursor:pointer;opacity:'+(run?'1':'.66')+(r.identifier===expandedId?';outline:2px solid #4a86c5':'')+'"><div class="id">'+r.identifier+'</div>'+
  '<div class="title">'+esc(r.title)+'</div>'+
  '<div class="row"><span class="badge" style="background:'+c+'2a;color:'+c+'">'+esc(r.state)+'</span><span style="display:flex;gap:10px;align-items:center">'+(r.prUrl?'<a href="'+r.prUrl+'" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:#4a86c5;text-decoration:none;font-size:11px">PR #'+(r.prUrl.split("/pull/")[1]||"")+' &#8599;</a>':'')+(run?'<span class="t muted">&#9201; '+dur(now-r.startedAt)+'</span>':'')+'</span></div>'+
  (run?'<div class="row"><span class="muted" style="display:block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">turn '+(r.turn||0)+' &middot; '+esc((r.activity||'').slice(0,64))+'</span></div>':'')+
  '<div class="row">'+foot+'</div></div>';
}
function render(){
 const now=Date.now();
 const items=snap.items||[];
 const run=items.filter(r=>r.status==='running').length,q=items.filter(r=>r.status==='queued').length,rt=items.filter(r=>r.status==='retrying').length,hf=items.filter(r=>r.status==='handoff').length;
 scope.textContent=snap.scope||'';
 count.textContent=run+' running'+(rt?' · '+rt+' retrying':'')+(q?' · '+q+' queued':'')+(hf?' · '+hf+' handed off':'')+' · '+(snap.cap||0)+' cap';
 clock.textContent=new Date().toLocaleTimeString();
 if(!items.length){board.innerHTML='<div class="empty">no '+esc(snap.scope||'dark-factory')+' tickets in scope</div>';return;}
 const buckets=COLS.map(()=>[]),other=[];
 for(const r of items){const i=colIdx(r.state);if(i<0)other.push(r);else buckets[i].push(r);}
 const cols=COLS.map((col,i)=>'<div class="col"><div class="colh">'+col.name+'<span class="ct">'+buckets[i].length+'</span></div>'+(buckets[i].length?buckets[i].map(r=>cardHtml(r,now)).join(''):'<div class="colempty">&mdash;</div>')+'</div>');
 if(other.length)cols.push('<div class="col"><div class="colh">Other<span class="ct">'+other.length+'</span></div>'+other.map(r=>cardHtml(r,now)).join('')+'</div>');
 board.innerHTML=cols.join('');
}
let expandedId=null;
board.addEventListener('click',e=>{const c=e.target.closest('[data-id]');if(!c)return;const id=c.getAttribute('data-id');expandedId=(expandedId===id)?null:id;syncDrawer();});
document.getElementById('drawerClose').addEventListener('click',()=>{expandedId=null;syncDrawer();});
function syncDrawer(){const d=document.getElementById('drawer');if(!expandedId){d.style.display='none';return;}d.style.display='block';const it=(snap.items||[]).find(x=>x.identifier===expandedId);document.getElementById('drawerId').innerHTML=esc(expandedId)+(it?' <span class="muted">'+esc(it.state)+'</span>':'')+(it&&it.prUrl?' <a href="'+it.prUrl+'" target="_blank" rel="noopener" style="color:#6aa3da;text-decoration:none">PR #'+(it.prUrl.split("/pull/")[1]||"")+' &#8599;</a>':'');pullLog();}
function logHtml(line){var t=(line||'').replace(/^\\n+/,''),e=esc(t);
 if(t.indexOf('\\u2500\\u2500')===0)return '<div class="lg lg-turn">'+e+'</div>';
 if(t.indexOf('\\u25cf ')===0)return '<div class="lg lg-msg"><b>\\u25cf</b> '+esc(t.slice(2))+'</div>';
 if(t.indexOf('$ ')===0)return '<div class="lg lg-cmd"><b>$</b> '+esc(t.slice(2))+'</div>';
 if(t.indexOf('\\u2699')===0)return '<div class="lg lg-tool">'+e+'</div>';
 if(t.indexOf('\\u270e')===0)return '<div class="lg lg-edit">'+e+'</div>';
 return '<div class="lg">'+e+'</div>';}
async function pullLog(){if(!expandedId)return;try{const j=await (await fetch('/log?id='+encodeURIComponent(expandedId))).json();const b=document.getElementById('logbody');const atEnd=b.scrollTop+b.clientHeight>=b.scrollHeight-60;b.innerHTML=(j.log&&j.log.length)?j.log.map(logHtml).join(''):'<div class="lg" style="color:var(--mut)">(no log yet)</div>';if(atEnd)b.scrollTop=b.scrollHeight;}catch(e){}}
setInterval(render,1000);setInterval(pull,1000);setInterval(pullLog,1000);pull();
</script></body></html>`
