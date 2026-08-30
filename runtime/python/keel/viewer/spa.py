"""The viewer's single-file SPA — macOS aesthetic meets Kibana intuitiveness.

Dependency-free vanilla JS + inline-SVG charts so ``keel view`` works with no build
step. Three views over the event log:
  * Overview — aggregate KPIs + spend-by-day, status, and top-graph charts.
  * Discover — a faceted, filterable event stream for one run (Kibana-style), with a
    type histogram, facets, full-text filter, and a prompt/response drill-down drawer.
  * Costs — the cost dashboard (by graph/model/node/tenant/day + most-expensive board).
"""
from __future__ import annotations

INDEX_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>KEEL</title>
<style>
:root{
  --accent:#0a84ff; --accent-soft:#0a84ff22;
  --bg:#ececf0; --bg2:#f6f6f8; --panel:rgba(255,255,255,.72); --panel-solid:#fff;
  --side:rgba(245,245,247,.72); --fg:#1d1d1f; --fg2:#6e6e73; --line:rgba(0,0,0,.10);
  --hair:rgba(0,0,0,.06); --shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06);
  --ok:#30b65a; --bad:#ff3b30; --warn:#ff9f0a; --run:#0a84ff; --mut:#8e8e93;
  --radius:12px; --radius-sm:8px;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#1c1c1e; --bg2:#161618; --panel:rgba(44,44,46,.66); --panel-solid:#2c2c2e;
    --side:rgba(30,30,32,.7); --fg:#f5f5f7; --fg2:#a1a1a6; --line:rgba(255,255,255,.12);
    --hair:rgba(255,255,255,.07); --shadow:0 1px 3px rgba(0,0,0,.4),0 12px 30px rgba(0,0,0,.35);
    --ok:#32d74b; --bad:#ff453a; --warn:#ffd60a; --run:#0a84ff; --mut:#8e8e93;
  }
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0; color:var(--fg);
  background:
    radial-gradient(1200px 700px at 80% -10%, var(--accent-soft), transparent 60%),
    var(--bg);
  font:13.5px/1.5 -apple-system,"SF Pro Text",BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
}
.toolbar{
  position:sticky; top:0; z-index:30; height:52px; display:flex; align-items:center; gap:14px;
  padding:0 16px; background:var(--panel); backdrop-filter:saturate(180%) blur(20px);
  -webkit-backdrop-filter:saturate(180%) blur(20px); border-bottom:1px solid var(--hair);
}
.brand{display:flex; align-items:center; gap:9px; font-weight:680; letter-spacing:-.2px}
.brand .dot{width:11px;height:11px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.brand small{color:var(--fg2); font-weight:520}
.seg{display:flex; background:var(--hair); border-radius:9px; padding:2px; margin-left:6px}
.seg button{
  border:0; background:transparent; color:var(--fg2); font:inherit; font-weight:560;
  padding:5px 13px; border-radius:7px; cursor:pointer; transition:.18s;
}
.seg button.on{background:var(--panel-solid); color:var(--fg); box-shadow:var(--shadow)}
.search{margin-left:auto; position:relative}
.search input{
  width:230px; height:32px; border:1px solid var(--line); border-radius:9px; padding:0 12px 0 32px;
  background:var(--panel-solid); color:var(--fg); font:inherit; outline:none; transition:.2s;
}
.search input:focus{border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); width:280px}
.search svg{position:absolute; left:10px; top:8px; opacity:.45}
.wrap{display:grid; grid-template-columns:264px 1fr; height:calc(100vh - 52px)}
.side{
  border-right:1px solid var(--hair); background:var(--side);
  backdrop-filter:saturate(180%) blur(20px); -webkit-backdrop-filter:saturate(180%) blur(20px);
  overflow:auto; padding:10px 8px;
}
.side h4{margin:8px 8px 6px; font-size:11px; letter-spacing:.5px; text-transform:uppercase; color:var(--fg2)}
.run{
  padding:9px 11px; border-radius:10px; cursor:pointer; margin-bottom:2px; transition:.14s;
  display:flex; flex-direction:column; gap:3px;
}
.run:hover{background:var(--hair)}
.run.sel{background:var(--accent); color:#fff; box-shadow:var(--shadow)}
.run.sel .gid,.run.sel .meta{color:#fff}
.run .gid{font-weight:580; font-size:13px}
.run .meta{font-size:11px; color:var(--fg2); display:flex; gap:6px; align-items:center}
main{overflow:auto; padding:20px 24px 60px}
.dot-s{width:7px;height:7px;border-radius:50%;display:inline-block}
.s-completed{background:var(--ok)} .s-failed{background:var(--bad)}
.s-paused{background:var(--warn)} .s-running{background:var(--run)} .s-pending{background:var(--mut)}
.kpis{display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:14px; margin-bottom:20px}
.kpi{background:var(--panel-solid); border:1px solid var(--hair); border-radius:var(--radius); padding:16px; box-shadow:var(--shadow)}
.kpi .label{font-size:12px; color:var(--fg2); font-weight:540}
.kpi .val{font-size:26px; font-weight:680; letter-spacing:-.5px; margin-top:4px}
.kpi .val small{font-size:14px; color:var(--fg2); font-weight:540}
.cards{display:grid; grid-template-columns:1fr 1fr; gap:16px}
.card{background:var(--panel-solid); border:1px solid var(--hair); border-radius:var(--radius); padding:16px 18px; box-shadow:var(--shadow)}
.card h3{margin:0 0 12px; font-size:13px; font-weight:620; display:flex; justify-content:space-between; align-items:center}
.card h3 small{color:var(--fg2); font-weight:500}
.bars{display:flex; flex-direction:column; gap:8px}
.bar{display:grid; grid-template-columns:120px 1fr auto; gap:10px; align-items:center; font-size:12.5px}
.bar .k{color:var(--fg2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.bar .track{height:8px; background:var(--hair); border-radius:5px; overflow:hidden}
.bar .fill{height:100%; background:linear-gradient(90deg,var(--accent),#5e5ce6); border-radius:5px; transition:width .5s cubic-bezier(.2,.7,.2,1)}
.bar .v{font-variant-numeric:tabular-nums; color:var(--fg)}
table{width:100%; border-collapse:collapse; font-size:12.5px}
th{text-align:left; color:var(--fg2); font-weight:560; padding:7px 10px; position:sticky; top:0;
   background:var(--panel-solid); border-bottom:1px solid var(--hair); font-size:11.5px}
td{padding:7px 10px; border-bottom:1px solid var(--hair); vertical-align:middle}
tr.clk{cursor:pointer} tr.clk:hover td{background:var(--hair)}
.num{text-align:right; font-variant-numeric:tabular-nums; color:var(--fg2)}
.pill{display:inline-flex; align-items:center; gap:5px; padding:2px 9px; border-radius:20px; font-size:11px; font-weight:560; border:1px solid var(--hair)}
.t-run{color:var(--run)} .t-llm{color:#5e5ce6} .t-tool{color:#0a84ff} .t-step{color:var(--fg2)}
.t-fail{color:var(--bad)} .t-gate,.t-warn{color:var(--warn)} .t-route{color:#bf5af2} .t-mem{color:#30b65a}
.disc{display:grid; grid-template-columns:200px 1fr; gap:16px}
.facets{display:flex; flex-direction:column; gap:14px}
.facet{background:var(--panel-solid); border:1px solid var(--hair); border-radius:var(--radius); padding:12px; box-shadow:var(--shadow)}
.facet h4{margin:0 0 8px; font-size:11px; letter-spacing:.4px; text-transform:uppercase; color:var(--fg2)}
.chip{display:flex; justify-content:space-between; align-items:center; padding:5px 8px; border-radius:7px; cursor:pointer; font-size:12px; transition:.12s}
.chip:hover{background:var(--hair)}
.chip.on{background:var(--accent); color:#fff}
.chip .c{font-variant-numeric:tabular-nums; opacity:.7; font-size:11px}
.histo{display:flex; align-items:flex-end; gap:3px; height:60px; margin-bottom:14px; background:var(--panel-solid);
  border:1px solid var(--hair); border-radius:var(--radius); padding:10px; box-shadow:var(--shadow)}
.histo .h{flex:1; background:linear-gradient(180deg,var(--accent),#5e5ce6); border-radius:3px 3px 0 0; min-height:2px; transition:.3s; cursor:pointer}
.histo .h:hover{filter:brightness(1.15)}
.evtable{background:var(--panel-solid); border:1px solid var(--hair); border-radius:var(--radius); overflow:hidden; box-shadow:var(--shadow)}
.evtable .scroll{max-height:calc(100vh - 320px); overflow:auto}
.seam td{background:var(--accent-soft)!important}
.muted{color:var(--fg2)}
.drawer{position:fixed; right:0; top:52px; bottom:0; width:46%; min-width:420px; background:var(--panel);
  backdrop-filter:saturate(180%) blur(30px); -webkit-backdrop-filter:saturate(180%) blur(30px);
  border-left:1px solid var(--line); box-shadow:-20px 0 60px rgba(0,0,0,.18);
  transform:translateX(100%); transition:transform .32s cubic-bezier(.2,.8,.2,1); z-index:40; display:flex; flex-direction:column}
.drawer.open{transform:translateX(0)}
.drawer header{display:flex; align-items:center; gap:10px; padding:14px 18px; border-bottom:1px solid var(--hair)}
.drawer header .x{margin-left:auto; cursor:pointer; color:var(--fg2); width:28px; height:28px; border-radius:8px; display:grid; place-items:center}
.drawer header .x:hover{background:var(--hair)}
.drawer .body{overflow:auto; padding:16px 18px}
.drawer pre{white-space:pre-wrap; word-break:break-word; background:var(--bg2); padding:12px; border-radius:10px; border:1px solid var(--hair); font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.dk{font-size:11px; letter-spacing:.4px; text-transform:uppercase; color:var(--fg2); margin:14px 0 6px}
.btn{border:1px solid var(--line); background:var(--panel-solid); color:var(--fg); font:inherit; font-weight:540;
  padding:6px 12px; border-radius:9px; cursor:pointer; transition:.15s}
.btn:hover{background:var(--hair)}
.btn.primary{background:var(--accent); color:#fff; border-color:transparent}
.empty{display:grid; place-items:center; height:60vh; color:var(--fg2); gap:8px; text-align:center}
.empty .big{font-size:34px}
.tag{font-size:11px; padding:2px 7px; border-radius:6px; background:var(--hair); color:var(--fg2)}
</style>
</head>
<body>
<div class="toolbar">
  <div class="brand"><span class="dot"></span>KEEL <small>durable execution</small></div>
  <div class="seg" id="seg">
    <button data-v="overview" class="on">Overview</button>
    <button data-v="discover">Discover</button>
    <button data-v="costs">Costs</button>
  </div>
  <div class="search">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
    <input id="runsearch" placeholder="Filter runs…"/>
  </div>
</div>
<div class="wrap">
  <aside class="side"><h4>Runs</h4><div id="runs"></div></aside>
  <main id="main"></main>
</div>
<div class="drawer" id="drawer">
  <header><strong id="dtitle"></strong><span class="x" onclick="closeDrawer()">✕</span></header>
  <div class="body" id="dbody"></div>
</div>
<script>
const $=s=>document.querySelector(s);
const api=async u=>(await fetch(u)).json();
const fmt$=v=>'$'+(v||0).toFixed(v<0.01?6:4);
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
let RUNS=[], STATE={view:'overview', runId:null, run:null, f:{types:new Set(), node:null, q:''}};

function tcls(t){if(t.startsWith('run.'))return 't-run';if(t.startsWith('llm'))return 't-llm';
  if(t.startsWith('tool'))return t.includes('denied')?'t-fail':'t-tool';if(t.startsWith('route'))return 't-route';
  if(t.startsWith('gate'))return 't-gate';if(t.startsWith('budget'))return 't-warn';if(t.startsWith('memory'))return 't-mem';
  if(t.includes('failed'))return 't-fail';return 't-step';}

function bars(obj, fmt, max){
  const e=Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,max||8);
  const mx=Math.max(1,...e.map(x=>x[1]));
  return `<div class="bars">`+e.map(([k,v])=>`<div class="bar"><span class="k" title="${esc(k)}">${esc(k)}</span>
    <span class="track"><span class="fill" style="width:${(v/mx*100).toFixed(1)}%"></span></span>
    <span class="v">${fmt(v)}</span></div>`).join('')+(e.length?'':'<span class="muted">none</span>')+`</div>`;
}

async function loadRuns(){
  RUNS=await api('/api/runs');
  renderRuns();
}
function renderRuns(){
  const q=($('#runsearch').value||'').toLowerCase();
  const list=RUNS.filter(r=>!q||r.run_id.toLowerCase().includes(q)||r.graph_id.toLowerCase().includes(q));
  $('#runs').innerHTML=list.map(r=>`<div class="run ${r.run_id===STATE.runId?'sel':''}" onclick="openRun('${r.run_id}')">
    <span class="gid">${esc(r.graph_id)}</span>
    <span class="meta">${esc(r.run_id.slice(0,16))}…</span></div>`).join('')
    || '<div class="muted" style="padding:10px">No runs. Try <code>keel run --mock</code>.</div>';
}

function setView(v){STATE.view=v; document.querySelectorAll('#seg button').forEach(b=>b.classList.toggle('on',b.dataset.v===v)); render();}
function render(){
  if(STATE.view==='overview') return renderOverview();
  if(STATE.view==='costs') return renderCosts();
  if(STATE.view==='discover') return STATE.run?renderDiscover():emptyDiscover();
}
function emptyDiscover(){$('#main').innerHTML=`<div class="empty"><div class="big">🔍</div>
  <div>Select a run from the sidebar to explore its event stream.</div></div>`;}

async function renderOverview(){
  const o=await api('/api/overview');
  const statusBars={}; for(const[k,v]of Object.entries(o.by_status)) statusBars[k]=v;
  $('#main').innerHTML=`
    <div class="kpis">
      <div class="kpi"><div class="label">Runs</div><div class="val">${o.runs}</div></div>
      <div class="kpi"><div class="label">Total spend</div><div class="val">${fmt$(o.total_usd)}</div></div>
      <div class="kpi"><div class="label">Events</div><div class="val">${o.total_events.toLocaleString()}</div></div>
      <div class="kpi"><div class="label">Tokens</div><div class="val">${(o.total_tokens_in+o.total_tokens_out).toLocaleString()}<small> in/out</small></div></div>
    </div>
    <div class="cards">
      <div class="card"><h3>Spend by day</h3>${bars(o.by_day,fmt$)}</div>
      <div class="card"><h3>Runs by status</h3>${bars(o.by_status,v=>v)}</div>
      <div class="card"><h3>Runs by graph</h3>${bars(o.by_graph,v=>v)}</div>
      <div class="card"><h3>Recent runs <small>${o.recent.length}</small></h3>
        <div style="max-height:230px;overflow:auto"><table><thead><tr><th>graph</th><th>status</th><th class="num">events</th><th class="num">cost</th></tr></thead>
        <tbody>${o.recent.map(r=>`<tr class="clk" onclick="openRun('${r.run_id}')">
          <td>${esc(r.graph_id)}</td><td><span class="dot-s s-${r.status}"></span> ${r.status}</td>
          <td class="num">${r.events}</td><td class="num">${fmt$(r.cost_usd)}</td></tr>`).join('')}</tbody></table></div></div>
    </div>`;
}

async function renderCosts(){
  const c=await api('/api/costs');
  const exp=c.most_expensive.map(s=>`<tr><td>${esc(s.graph_id)}.${esc(s.node_id)}</td>
    <td class="muted">${esc(s.run_id.slice(0,14))}…</td><td class="num">${fmt$(s.usd)}</td></tr>`).join('');
  $('#main').innerHTML=`
    <div class="kpis"><div class="kpi"><div class="label">Total spend</div><div class="val">${fmt$(c.total_usd)}</div></div></div>
    <div class="cards">
      <div class="card"><h3>By graph</h3>${bars(c.by_graph,fmt$)}</div>
      <div class="card"><h3>By model</h3>${bars(c.by_model,fmt$)}</div>
      <div class="card"><h3>By tenant</h3>${bars(c.by_tenant,fmt$)}</div>
      <div class="card"><h3>By day</h3>${bars(c.by_day,fmt$)}</div>
    </div>
    <div class="card" style="margin-top:16px"><h3>Most expensive steps</h3>
      <table><thead><tr><th>step</th><th>run</th><th class="num">cost</th></tr></thead><tbody>${exp||''}</tbody></table></div>`;
}

async function openRun(id){
  STATE.runId=id; STATE.f={types:new Set(),node:null,q:''};
  STATE.run=await api('/api/runs/'+id);
  document.querySelectorAll('.run').forEach(d=>d.classList.remove('sel'));
  renderRuns();
  setView('discover');
}

function renderDiscover(){
  const r=STATE.run, ev=r.events;
  const counts={}, nodes={};
  ev.forEach(e=>{counts[e.type]=(counts[e.type]||0)+1; if(e.node_id)nodes[e.node_id]=(nodes[e.node_id]||0)+1;});
  const f=STATE.f;
  const shown=ev.filter(e=>(!f.types.size||f.types.has(e.type))&&(!f.node||e.node_id===f.node)
    &&(!f.q||JSON.stringify(e).toLowerCase().includes(f.q.toLowerCase())));
  const gate=gatePanel(r);
  const histo=ev.length?histogram(ev):'';
  const rows=shown.map(e=>{
    const seam=e.type==='run.resumed'?' seam':''; const clk=e.payload_ref?'clk':'';
    const onclk=e.payload_ref?`onclick="drill('${e.payload_ref}','${esc(e.type)} ${esc(e.node_id||'')}')"`:'';
    const tok=e.tokens?`${e.tokens.input}→${e.tokens.output}`:'';
    return `<tr class="${clk}${seam}" ${onclk}><td class="num">${e.seq}</td>
      <td><span class="pill ${tcls(e.type)}">${e.type}</span></td><td>${esc(e.node_id||'')}</td>
      <td class="num">${tok}</td><td class="num">${e.cost_usd?fmt$(e.cost_usd):''}</td>
      <td class="muted">${esc(dataline(e))}</td></tr>`;}).join('');
  const dur=ev.length?((new Date(ev[ev.length-1].ts)-new Date(ev[0].ts))/1000).toFixed(2)+'s':'—';
  $('#main').innerHTML=`
    <div class="kpis">
      <div class="kpi"><div class="label">Status</div><div class="val" style="font-size:20px"><span class="dot-s s-${r.status}"></span> ${r.status}</div></div>
      <div class="kpi"><div class="label">Cost</div><div class="val">${fmt$(r.total_cost_usd)}</div></div>
      <div class="kpi"><div class="label">Tokens</div><div class="val">${r.total_tokens_in}<small>→${r.total_tokens_out}</small></div></div>
      <div class="kpi"><div class="label">Events · duration</div><div class="val">${ev.length}<small> · ${dur}</small></div></div>
    </div>${gate}${histo}
    <div class="disc">
      <div class="facets">
        <div class="facet"><h4>Event type</h4>${Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([t,c])=>
          `<div class="chip ${f.types.has(t)?'on':''}" onclick="toggleType('${t}')"><span class="${tcls(t)}">${t}</span><span class="c">${c}</span></div>`).join('')}</div>
        <div class="facet"><h4>Node</h4>${Object.entries(nodes).map(([n,c])=>
          `<div class="chip ${f.node===n?'on':''}" onclick="toggleNode('${esc(n)}')"><span>${esc(n)}</span><span class="c">${c}</span></div>`).join('')||'<span class="muted">—</span>'}</div>
      </div>
      <div>
        <div class="search" style="margin:0 0 10px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          <input id="evq" placeholder="Filter events…" value="${esc(f.q)}" oninput="setQ(this.value)"/></div>
        <div class="evtable"><div class="scroll"><table><thead><tr><th>#</th><th>type</th><th>node</th><th class="num">tok</th><th class="num">cost</th><th>detail</th></tr></thead>
          <tbody>${rows||'<tr><td colspan=6 class="muted" style="padding:18px">No events match the filter.</td></tr>'}</tbody></table></div></div>
        <div class="muted" style="margin-top:8px;font-size:11.5px">${shown.length} of ${ev.length} events</div>
      </div>
    </div>`;
}
function histogram(ev){
  const N=Math.min(48,Math.max(12,ev.length)); const buckets=new Array(N).fill(0);
  ev.forEach((e,i)=>buckets[Math.floor(i/ev.length*N)]++);
  const mx=Math.max(1,...buckets);
  return `<div class="histo">${buckets.map(b=>`<span class="h" style="height:${(b/mx*100)}%" title="${b} events"></span>`).join('')}</div>`;
}
function dataline(e){const d=e.data||{}; const k=Object.keys(d).filter(x=>x!=='context'&&x!=='context_tokens');
  if(!k.length) return e.payload_ref?'▸ payload':''; return k.slice(0,3).map(x=>`${x}=${JSON.stringify(d[x])}`).join(' ').slice(0,90);}
function toggleType(t){STATE.f.types.has(t)?STATE.f.types.delete(t):STATE.f.types.add(t); renderDiscover();}
function toggleNode(n){STATE.f.node=STATE.f.node===n?null:n; renderDiscover();}
function setQ(v){STATE.f.q=v; renderDiscover(); const i=$('#evq'); if(i){i.focus(); i.setSelectionRange(v.length,v.length);}}

function openGates(r){const decided=new Set();
  r.events.forEach(e=>{if(['gate.approved','gate.rejected','gate.expired'].includes(e.type))decided.add(e.node_id);});
  return r.events.filter(e=>e.type==='gate.opened'&&!decided.has(e.node_id)).map(e=>e.node_id);}
function gatePanel(r){const g=openGates(r); if(!g.length)return '';
  return g.map(n=>`<div class="card" style="margin-bottom:16px;display:flex;align-items:center;gap:12px">
    <span class="pill t-gate">⏸ human gate: ${esc(n)}</span><span class="muted">awaiting decision</span>
    <button class="btn primary" style="margin-left:auto" onclick="decide('${esc(n)}','approve')">Approve</button>
    <button class="btn" onclick="decide('${esc(n)}','reject')">Reject</button></div>`).join('');}
async function decide(node,d){await fetch(`/api/runs/${STATE.runId}/gates/${node}/${d}`,{method:'POST'});
  STATE.run=await api('/api/runs/'+STATE.runId); renderDiscover();}

async function drill(ref,title){const txt=await (await fetch('/api/blob/'+encodeURIComponent(ref))).text();
  $('#dtitle').textContent=title; $('#dbody').innerHTML=`<div class="dk">Payload</div><pre>${esc(txt)}</pre>`;
  $('#drawer').classList.add('open');}
function closeDrawer(){$('#drawer').classList.remove('open');}

$('#seg').addEventListener('click',e=>{if(e.target.dataset.v)setView(e.target.dataset.v);});
$('#runsearch').addEventListener('input',renderRuns);
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeDrawer();});
loadRuns(); render(); setInterval(loadRuns,5000);
</script>
</body>
</html>
"""
