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
}

export interface Snapshot {
  scope: string
  cap: number
  pollMs: number
  now: number
  items: BoardItem[] // the WHOLE board (every active+labeled ticket), not just the running ones
}

// A tiny status server: GET /state.json is the live orchestrator snapshot; GET / is a self-contained page that
// polls it and renders the board (kanban by pipeline stage) + a per-run log modal.
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

const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>bunion</title>
<style>
*{box-sizing:border-box}
:root{--bg:#0a0b0e;--surf:#14161b;--surf2:#1a1d24;--line:#22252d;--line2:#2c303a;--fg:#e7eaf0;--mut:#8b929e;--mut2:#596069;--accent:#5b8def}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:13.5px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
header{display:flex;align-items:center;gap:14px;padding:13px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(10,11,14,.82);backdrop-filter:blur(8px);z-index:10}
.brand{font-weight:600;letter-spacing:.2px;display:flex;align-items:center;gap:9px}
.mark{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px var(--accent)}
.sub{color:var(--mut);font-weight:400;font-size:12.5px;margin-left:2px}
.stats{display:flex;gap:7px;margin-left:6px;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--surf);border:1px solid var(--line);border-radius:7px;padding:3px 9px;font-size:12px}
.chip i{width:7px;height:7px;border-radius:50%}
.cap{color:var(--mut);font-size:12px;align-self:center}
.clock{margin-left:auto;color:var(--mut2);font-size:12px;font-variant-numeric:tabular-nums;font-family:ui-monospace,Menlo,monospace}
.board{display:flex;gap:12px;padding:18px 20px 26px;align-items:flex-start;overflow-x:auto;scroll-behavior:smooth}
.board::-webkit-scrollbar{height:10px}
.board::-webkit-scrollbar-thumb{background:var(--line2);border-radius:6px}
.board::-webkit-scrollbar-thumb:hover{background:#3a4150}
.board::-webkit-scrollbar-track{background:transparent}
.col{flex:0 0 248px;min-width:0;max-width:248px;display:flex;flex-direction:column;gap:9px}
.colh{display:flex;align-items:center;gap:8px;padding:1px 3px 5px;font-size:11.5px;font-weight:600;color:var(--mut);letter-spacing:.3px}
.colh i{width:7px;height:7px;border-radius:50%}
.colh .ct{margin-left:auto;color:var(--mut2);font-weight:500;font-variant-numeric:tabular-nums}
.colempty{color:#363c47;font-size:11.5px;padding:10px 0;text-align:center}
.card{background:var(--surf);border:1px solid var(--line);border-radius:11px;padding:11px 13px;cursor:pointer;overflow:hidden;transition:border-color .12s,background .12s}
.card:hover{background:var(--surf2);border-color:var(--line2)}
.card.run{border-left:2px solid var(--accent);padding-left:11px}
.ctop{display:flex;align-items:center;justify-content:space-between;gap:8px}
.cid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:600;letter-spacing:-.2px}
.pill{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:6px;white-space:nowrap}
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
.empty{color:var(--mut);padding:64px;text-align:center;width:100%}
#modal{position:fixed;inset:0;background:rgba(4,5,8,.6);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;z-index:50;padding:28px}
#mpanel{background:var(--surf);border:1px solid var(--line2);border-radius:14px;width:min(960px,100%);max-height:86vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.6)}
#mhead{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
#mbanner{margin:11px 16px 0;padding:9px 12px;border-radius:9px;font-size:12.5px;line-height:1.5}
#mbanner.nh{background:#e0564f18;border:1px solid #e0564f44;color:#eaa6a0}
#mbanner.nh b{color:#e0564f}
#mbanner.note{background:var(--surf2);border:1px solid var(--line);color:var(--mut)}
#mtitle{display:flex;align-items:center;gap:10px;font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:14px}
#mclose{margin-left:auto;cursor:pointer;color:var(--mut);font-size:12.5px}
#mclose:hover{color:var(--fg)}
#logbody{margin:0;padding:10px 16px 16px;overflow:auto;flex:1;font:12px/1.62 ui-monospace,SFMono-Regular,Menlo,monospace}
.lg{padding:.5px 0;white-space:pre-wrap;word-break:break-word}
.lg-turn{margin:13px 0 6px;color:#6aa3da;font-weight:700;border-top:1px solid var(--line);padding-top:10px;letter-spacing:.5px}
.lg-msg{color:var(--fg)}.lg-msg b{color:#46c08a}
.lg-cmd{color:#8b929e}.lg-cmd b{color:#46c08a}
.lg-tool{color:#d99a2b}.lg-edit{color:#b88cd9}
.live{width:7px;height:7px;border-radius:50%;background:#3fb27f;flex:none;animation:pulse 1.5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
</style></head><body>
<header>
 <div class="brand"><span class="mark"></span>bunion<span class="sub" id="scope"></span></div>
 <div class="stats" id="stats"></div>
 <span class="clock" id="clock"></span>
</header>
<div class="board" id="board"></div>
<div id="modal"><div id="mpanel">
 <div id="mhead"><span class="live"></span><span id="mtitle"></span><span id="mclose">close &#10005;</span></div>
 <div id="mbanner" style="display:none"></div>
 <div id="logbody"></div>
</div></div>
<script>
const SC=s=>({'Triage':'#7c8493','Backlog':'#7c8493','Todo':'#7c8493','In Progress':'#5b8def','QA Requested':'#d99a2b','QA Verify':'#c79a3a','QA blocked':'#e0564f','Ready to ship':'#3fb27f','Done':'#a371f7'}[s]||'#7c8493');
const ago=ms=>{let s=Math.max(0,Math.floor(ms/1000));if(s<60)return s+'s';let m=Math.floor(s/60);if(m<60)return m+'m '+(s%60)+'s';return Math.floor(m/60)+'h '+(m%60)+'m'};
const dur=ms=>{let s=Math.max(0,Math.floor(ms/1000)),m=Math.floor(s/60);return String(m).padStart(2,'0')+':'+String(s%60).padStart(2,'0')};
const esc=s=>(s||'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
const COLS=[
 {name:'Triage',c:'#6b7280',states:['Triage']},
 {name:'Backlog',c:'#6b7280',states:['Backlog']},
 {name:'Todo',c:'#8b93a1',states:['Todo']},
 {name:'In Progress',c:'#5b8def',states:['In Progress']},
 {name:'QA check',c:'#d99a2b',states:['QA Requested']},
 {name:'Verify QA',c:'#c79a3a',states:['QA Verify']},
 {name:'Blocked',c:'#e0564f',states:['QA blocked']},
 {name:'Ready',c:'#3fb27f',states:['Ready to ship']},
 {name:'Merged',c:'#a371f7',states:['Done']}];
function colIdx(st){for(var i=0;i<COLS.length;i++)if(COLS[i].states.indexOf(st)>=0)return i;return -1;}
let snap={items:[],cap:0,scope:''};
async function pull(){try{snap=await (await fetch('/state.json')).json()}catch(e){}render()}
function cardHtml(r,now){
 const run=r.status==='running';
 const act=now-r.lastActivity,dc=act<30000?'#3fb27f':act<120000?'#d99a2b':'#e0564f';
 const pr=r.prUrl?'<a class="pr" href="'+r.prUrl+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">#'+(r.prUrl.split("/pull/")[1]||"")+'</a>':'';
 let status;
 if(run) status='<span class="ag t-ago"><i class="dot" style="background:'+dc+'"></i>active '+ago(act)+'</span>';
 else if(r.status==='retrying') status='<span class="ag">&#8635; retry '+(r.retryDueAt?'in '+ago(r.retryDueAt-now):'soon')+'</span>';
 else if(r.state==='QA blocked') status='<span class="ag" style="color:#e0564f">&#9888; needs human</span>';
 else if(r.state==='Done') status='<span class="ag" style="color:#a371f7">&#10004; merged</span>';
 else if(r.state==='Ready to ship') status='<span class="ag" style="color:#3fb27f">&#10004; ready</span>';
 else if(r.status==='handoff') status='<span class="ag">&#10004; in review</span>';
 else status='<span class="ag">&#9203; queued</span>';
 const tot=r.enteredAt?'<span class="t-tot clk" title="total time in the factory">&#9201; '+ago((r.endedAt||now)-r.enteredAt)+'</span>':'';
 return '<div class="card'+(run?' run':'')+'" data-id="'+r.identifier+'">'+
  '<div class="ctop"><span class="cid">'+r.identifier+'</span>'+pr+'</div>'+
  '<div class="ctitle">'+esc(r.title)+'</div>'+
  (run?'<div class="cact t-act">turn '+(r.turn||0)+' &middot; '+esc((r.activity||'').slice(0,70))+'</div>':'')+
  '<div class="cfoot">'+status+'<span class="meta">'+tot+'</span></div>'+
 '</div>';
}
function colHtml(col,arr,now){return '<div class="col"><div class="colh"><i style="background:'+col.c+'"></i>'+col.name+'<span class="ct">'+arr.length+'</span></div>'+(arr.length?arr.map(r=>cardHtml(r,now)).join(''):'<div class="colempty">empty</div>')+'</div>';}
let lastSig='';
function render(){
 const items=snap.items||[];
 const run=items.filter(r=>r.status==='running').length,q=items.filter(r=>r.status==='queued').length,rt=items.filter(r=>r.status==='retrying').length;
 scope.textContent=snap.scope||'';
 const chip=(col,n,lab)=>'<span class="chip"><i style="background:'+col+'"></i>'+n+' '+lab+'</span>';
 stats.innerHTML=chip('#3fb27f',run,'running')+(q?chip('#7c8493',q,'queued'):'')+(rt?chip('#d99a2b',rt,'retrying'):'')+'<span class="cap">'+(snap.cap||0)+' slots</span>';
 // Rebuild the board ONLY when structure changes (membership / state / status / pr); live fields tick in place.
 const sig=JSON.stringify(items.map(r=>[r.identifier,r.state,r.status,r.host,r.prUrl,r.retryAttempt]));
 if(sig!==lastSig){
  lastSig=sig;const now=Date.now();
  if(!items.length){board.innerHTML='<div class="empty">no '+esc(snap.scope||'dark-factory')+' tickets in scope</div>';}
  else{
   const bk=COLS.map(()=>[]),other=[];
   for(const r of items){const i=colIdx(r.state);if(i<0)other.push(r);else bk[i].push(r);}
   let html=COLS.map((col,i)=>colHtml(col,bk[i],now)).join('');
   if(other.length)html+=colHtml({name:'Other',c:'#596069'},other,now);
   board.innerHTML=html;
  }
 }
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
 });
}
let expandedId=null;
function syncHead(){const it=(snap.items||[]).find(x=>x.identifier===expandedId);const c=it?SC(it.state):'#7c8493';
 document.getElementById('mtitle').innerHTML=esc(expandedId||'')+(it?' <span class="pill" style="color:'+c+';background:'+c+'22">'+esc(it.state)+'</span>':'')+(it&&it.enteredAt?' <span class="clk" style="color:var(--mut)" title="total time in the factory">&#9201; '+ago((it.endedAt||Date.now())-it.enteredAt)+'</span>':'')+(it&&it.host?' <span class="clk" style="color:var(--mut2)">&#9709; '+esc(it.host.replace(/\\.exe\\.xyz$/,''))+'</span>':'')+(it&&it.prUrl?' <a class="pr" href="'+it.prUrl+'" target="_blank" rel="noopener">PR #'+(it.prUrl.split("/pull/")[1]||"")+'</a>':'')+(it&&it.url?' <a class="pr" style="background:#8b929e1a;color:var(--mut)" href="'+it.url+'" target="_blank" rel="noopener">Linear &#8599;</a>':'');
 const ban=document.getElementById('mbanner');
 if(it&&it.state==='QA blocked'){ban.style.display='block';ban.className='nh';ban.innerHTML='<b>&#9888; Needs human</b> &mdash; '+(it.note?esc(it.note):'open the QA notes in Linear');}
 else if(it&&it.note&&it.status!=='running'){ban.style.display='block';ban.className='note';ban.innerHTML=esc(it.note);}
 else{ban.style.display='none';}}
function openModal(id){expandedId=id;document.getElementById('modal').style.display='flex';document.getElementById('logbody').innerHTML='<div class="lg" style="color:var(--mut)">loading&hellip;</div>';syncHead();pullLog();}
function closeModal(){expandedId=null;document.getElementById('modal').style.display='none';}
board.addEventListener('click',function(e){const c=e.target.closest('[data-id]');if(!c)return;openModal(c.getAttribute('data-id'));});
document.getElementById('mclose').addEventListener('click',closeModal);
document.getElementById('modal').addEventListener('click',function(e){if(e.target.id==='modal')closeModal();});
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeModal();});
function logHtml(line){var t=(line||'').replace(/^\\n+/,''),e=esc(t);
 if(t.indexOf('\\u2500\\u2500')===0)return '<div class="lg lg-turn">'+e+'</div>';
 if(t.indexOf('\\u25cf ')===0)return '<div class="lg lg-msg"><b>\\u25cf</b> '+esc(t.slice(2))+'</div>';
 if(t.indexOf('$ ')===0)return '<div class="lg lg-cmd"><b>$</b> '+esc(t.slice(2))+'</div>';
 if(t.indexOf('\\u2699')===0)return '<div class="lg lg-tool">'+e+'</div>';
 if(t.indexOf('\\u270e')===0)return '<div class="lg lg-edit">'+e+'</div>';
 return '<div class="lg">'+e+'</div>';}
async function pullLog(){if(!expandedId)return;try{const j=await (await fetch('/log?id='+encodeURIComponent(expandedId))).json();const b=document.getElementById('logbody');const atEnd=b.scrollTop+b.clientHeight>=b.scrollHeight-60;b.innerHTML=(j.log&&j.log.length)?j.log.map(logHtml).join(''):'<div class="lg" style="color:var(--mut)">(no log yet)</div>';if(atEnd)b.scrollTop=b.scrollHeight;}catch(e){}}
setInterval(pull,1000);setInterval(tickLive,1000);setInterval(function(){if(expandedId){pullLog();syncHead();}},1000);pull();
</script></body></html>`
