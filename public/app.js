/* ============================================================
   musik.build — app UI + wiring (Loop Graph edition)
   A "song" = a Loop record whose graph = {nodes[],edges[],startId}.
   Each node is an 8-bit loop (its own drums/808/keys/bars pattern).
   Every mutation → API (mock or real) → recorded as an Op on THIS song.
   History is per-song (no global broadcast). Publish + Flip (接力) are
   first-class. All user-facing text is i18n (t() / [data-i18n]).
   ============================================================ */
"use strict";
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

/* ---------- current song ---------- */
let loop = null;        // API record; loop.graph = {nodes,edges,startId}
let graph = null;       // alias loop.graph
let selId = null;       // selected node id
let st = emptyState();  // alias selected node's .state

function nodeById(id){ return graph.nodes.find(n=>n.id===id); }
function selNode(){ return nodeById(selId); }

function useLoop(rec){
  loop = rec;
  loop.graph = normalizeGraph(loop.graph);
  graph = loop.graph;
  $('#loopAuthorWrap'); // noop guard
  selId = graph.startId && nodeById(graph.startId) ? graph.startId
        : (graph.nodes[0] ? graph.nodes[0].id : null);
  const ff = loop.forkedFrom;
  $('#lineage').style.display = ff? 'block':'none';
  if(ff) $('#lineageName').textContent = loop._forkedTitle || loop.title;
  $('#publishBtn').textContent = loop.published? t('board.published') : t('board.publish');
  $('#publishBtn').classList.toggle('on', !!loop.published);
  syncAlignUI();
  selectNode(selId, {silent:true});
  renderGraph(); refreshOps();
}
function syncAlignUI(){ if(!graph||!graph.master) return;
  $('#alignChk').checked=graph.master.align; $('#alignBpm').disabled=!graph.master.align; $('#alignBpm').value=graph.master.bpm; }
function normalizeGraph(g){
  if(g && Array.isArray(g.nodes) && g.nodes.length){
    g.nodes.forEach(n=>{ ensureShape(n.state); if(n.x==null)n.x=40; if(n.y==null)n.y=40; if(!n.reps)n.reps=2; });
    if(!Array.isArray(g.edges)) g.edges=[];
    if(!g.startId || !g.nodes.find(n=>n.id===g.startId)) g.startId=g.nodes[0].id;
    if(g.counter==null) g.counter=g.nodes.length;
    if(!g.master) g.master={align:false, bpm:(g.nodes[0].state.bpm)||120};   // per-graph whole-song tempo
    return g;
  }
  // migrate a bare/legacy pattern into a single node
  const pat = (g && g.grids) ? g : (g && g.nodes && g.nodes[0] && g.nodes[0].state) || starterState();
  return { nodes:[{id:'n1', k:'verse', x:40, y:110, reps:2, state:pat}], edges:[], startId:'n1', counter:1,
           master:{align:false, bpm:(pat.bpm)||120} };
}
function ensureShape(s){ if(!s) return;
  if(!s.grids) s.grids=emptyGrids();
  SECTIONS.forEach(sec=>{ if(!s.grids[sec.id]) s.grids[sec.id]=Array.from({length:sec.rows},()=>Array(STEPS).fill(false)); });
  if(!s.bars) s.bars={}; if(s.bpm==null)s.bpm=88; if(s.swing==null)s.swing=.14; if(!s.mood)s.mood='dark';
}

/* select a node → load its pattern into the canvas */
function selectNode(id, {silent=false}={}){
  const n=nodeById(id); if(!n) return;
  selId=id; st=n.state; curMood=st.mood; ensureShape(st);
  $('#nodeName').textContent = dispName(n) + (n.ghost?' '+t('board.proposal'):'');
  $('#bpm').value=st.bpm; $('#bpmVal').textContent=st.bpm;
  $('#swing').value=Math.round(st.swing*100); $('#swVal').textContent=Math.round(st.swing*100)+'%';
  $('#moodDark').classList.toggle('on',st.mood==='dark'); $('#moodBright').classList.toggle('on',st.mood==='bright');
  buildBoard();
  if(!silent) renderGraph();
}

/* record an op + persist graph. `meaningful=false` for cosmetic moves. */
async function op(action, payload){
  try{ await API.patchLoop(loop.id, action, payload, loop.graph); refreshOps(); }
  catch(e){
    if(/→ 403/.test(e.message)) toast(t('toast.notYours'));
    else toast(t('toast.saveFail',{err:e.message}));
  }
}

/* ================= account menu (handle + logout; demo-switch in mock) ================= */
function renderActor(){ const a=RAP.actor;
  $('#actorChip').innerHTML = (a.kind==='agent'?'🤖':'🧑')+' '+a.name;
  $('#actorChip').className = 'chip '+(a.kind==='agent'?'agent':'human');
  $('#acctHandle').textContent = '@'+(a.handle||a.name); }
$('#actorChip').addEventListener('click', e=>{ e.stopPropagation(); $('#acctMenu').classList.toggle('show'); });
$('#acctMenu').addEventListener('click', e=>e.stopPropagation());
document.addEventListener('click', ()=>$('#acctMenu').classList.remove('show'));
$('#logoutBtn').onclick=async()=>{
  if(!API.MOCK){ try{ await fetch('/logout',{credentials:'include'}); }catch(e){} }
  localStorage.removeItem(TOKEN_KEY); RAP.token=null;
  location.href = location.pathname;   // reload → login gate (live) / fresh (mock)
};

/* ================= canvas (selected node) ================= */
const cellEls={}; let phCols=[];
function buildBoard(){
  const wrap=$('#sections'); wrap.innerHTML=''; phCols=Array.from({length:STEPS},()=>[]);
  SECTIONS.forEach(sec=>{
    const div=document.createElement('div'); div.className='section sec-'+sec.id;
    div.innerHTML=`<div class="secHead"><span class="secName">${sec.name}</span>
      <span class="secHint">${t('sec.'+sec.id)}</span><button class="mini" data-clearsec="${sec.id}">✕</button></div>`;
    const grid=document.createElement('div'); grid.className='grid';
    grid.style.gridTemplateColumns=`64px repeat(${STEPS},1fr)`;
    cellEls[sec.id]=[];
    for(let row=0;row<sec.rows;row++){
      const lab=document.createElement('div'); lab.className='rowLabel';
      lab.textContent = sec.type==='drum'? sec.labels[row] : sec.type==='bars'? t('sec.word') : nName(rowToNote(sec,row));
      grid.appendChild(lab); cellEls[sec.id][row]=[];
      for(let c=0;c<STEPS;c++){
        const cell=document.createElement('div'); cell.className='cell'+(c%4===0?' q':'');
        cell.dataset.sec=sec.id; cell.dataset.row=row; cell.dataset.col=c;
        if(sec.type==='bars'){ const w=st.bars[c]; if(w){ cell.classList.add('hasword'); cell.textContent=w; } }
        grid.appendChild(cell); cellEls[sec.id][row][c]=cell; phCols[c].push(cell);
      }
    }
    div.appendChild(grid); wrap.appendChild(div);
  });
  paintAll();
}
function paintAll(){
  SECTIONS.forEach(sec=>{ for(let r=0;r<sec.rows;r++) for(let c=0;c<STEPS;c++){
    const el=cellEls[sec.id][r][c];
    el.classList.toggle('on', !!st.grids[sec.id][r][c]);
    el.classList.toggle('ghost', !!(ghost && ghost.section===sec.id && ghost.grid[r][c]));
    if(sec.type==='bars'){ const w=st.bars[c]; el.classList.toggle('hasword',!!w); el.textContent=w||''; }
  }});
}
function setPlayhead(s){ phCols.forEach(col=>col.forEach(c=>c.classList.remove('ph')));
  if(s>=0&&phCols[s]) phCols[s].forEach(c=>c.classList.add('ph')); }

let paintMode=null, paintedSecs=new Set();
$('#board').addEventListener('pointerdown',e=>{
  const el=e.target.closest('.cell'); if(!el||!loop) return;
  e.preventDefault(); paintMode=null; paintedSecs=new Set(); applyPaint(el);
  const move=ev=>applyPaint(document.elementFromPoint(ev.clientX,ev.clientY)?.closest('.cell'));
  const up=()=>{ window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',up);
    if(paintedSecs.size){ renderNodeThumb(selId); op('paint',{node:dispName(selNode()), sections:[...paintedSecs], on:paintMode}); paintedSecs=new Set(); } };
  window.addEventListener('pointermove',move); window.addEventListener('pointerup',up);
});
$('#board').addEventListener('dblclick',e=>{
  const el=e.target.closest('.cell'); if(!el||el.dataset.sec!=='bars'||!loop) return;
  const c=+el.dataset.col; const w=prompt(t('node.wordPrompt',{n:c+1}), st.bars[c]||'');
  if(w===null) return;
  if(w.trim()){ st.bars[c]=w.trim().slice(0,10); st.grids.bars[0][c]=true; } else { delete st.bars[c]; st.grids.bars[0][c]=false; }
  paintAll(); renderNodeThumb(selId); op('write_bar',{node:dispName(selNode()), step:c, word:st.bars[c]||null});
});
function applyPaint(el){
  if(!el||!el.dataset.sec) return;
  const {sec,row,col}=el.dataset, g=st.grids[sec][+row];
  if(paintMode===null) paintMode=!g[+col];
  if(g[+col]===paintMode) return;
  g[+col]=paintMode; el.classList.toggle('on',paintMode); paintedSecs.add(sec);
  if(sec==='bars' && !paintMode){ delete st.bars[+col]; el.classList.remove('hasword'); el.textContent=''; }
  if(paintMode){ preview(sec,+row); if(!playing) startLoop('node'); }
}
function preview(secId,row){ ensureAudio(); const t=AC.currentTime+.01; const sec=secById(secId);
  if(secId==='keys') keys(rig,t,rowToNote(sec,row));
  else if(secId==='k808') k808(rig,t,rowToNote(sec,row),.3,null);
  else if(secId==='bars') vox(rig,t,row===0);
  else { if(row===0)kick(rig,t); else if(row===1)snare(rig,t); else if(row===2)clap(rig,t); else hat(rig,t,1,row===4); } }
$('#sections').addEventListener('click',e=>{
  const cs=e.target.dataset?.clearsec;
  if(cs){ st.grids[cs]=Array.from({length:secById(cs).rows},()=>Array(STEPS).fill(false));
    if(cs==='bars') st.bars={}; paintAll(); renderNodeThumb(selId); op('erase',{node:dispName(selNode()), section:cs}); }
});

/* ================= transport ================= */
let AC=null, rig=null, playing=false, curStep=0, nextTime=0, timer=null, playMode='node';
let songSeq=null, songIdx=0, songRep=0;
function ensureAudio(){ if(AC){ if(AC.state==='suspended')AC.resume(); return; } AC=new (window.AudioContext||window.webkitAudioContext)(); rig=makeRig(AC); }
function stepDur(){ const s=(playMode==='song'&&songSeq)?songSeq[songIdx]:st; return 60/s.bpm/4; }
function swingOff(s){ const stt=(playMode==='song'&&songSeq)?songSeq[songIdx]:st; return (s%2===1)? stt.swing*stepDur()*.55 : 0; }
function startLoop(mode){ ensureAudio(); playMode=mode||'node'; playing=true;
  $('#playBtn').textContent='■'; $('#playBtn').classList.add('playing');
  $('#songPlayBtn').textContent = playMode==='song'?t('graph.stopSong'):t('graph.playSong');
  curStep=0; nextTime=AC.currentTime+.06;
  if(playMode==='song'){ songSeq=buildSong(); songIdx=0; songRep=0; if(!songSeq.length){ stopLoop(); toast(t('graph.noSections')); return; } setActiveNode(songSeq[0]._id); }
  timer=setInterval(tick,50); tick(); }
function stopLoop(){ playing=false; clearInterval(timer); $('#playBtn').textContent='▶'; $('#playBtn').classList.remove('playing');
  $('#songPlayBtn').textContent=t('graph.playSong'); setPlayhead(-1); setActiveNode(null); playMode='node'; }
function tick(){ while(nextTime < AC.currentTime+.18){
  const useSt=(playMode==='song'&&songSeq)?songSeq[songIdx]:st;
  const s=curStep, t=nextTime+swingOff(s);
  scheduleStep(rig, useSt, s, t, stepDur(), (playMode==='node')?ghost:null);
  const d=(t-AC.currentTime)*1000; setTimeout(()=>{ if(playing) setPlayhead(s); }, Math.max(0,d));
  nextTime+=stepDur(); curStep=(curStep+1)%STEPS;
  if(curStep===0 && playMode==='song'){                       // finished one 16-step pass of this node
    songRep++;
    if(songRep >= (songSeq[songIdx].reps||1)){                 // played it `reps` times → advance
      songRep=0; songIdx++;
      if(songIdx>=songSeq.length){ stopLoop(); return; }
      setActiveNode(songSeq[songIdx]._id);
    }
  }
} }
$('#playBtn').onclick=()=>{ if(!loop) return; (playing&&playMode==='node')?stopLoop():(stopLoop(),startLoop('node')); };
$('#songPlayBtn').onclick=()=>{ if(!loop) return; (playing&&playMode==='song')?stopLoop():(stopLoop(),startLoop('song')); };
$('#alignChk').onchange=e=>{ if(!graph) return; graph.master.align=e.target.checked; $('#alignBpm').disabled=!e.target.checked;
  op('set_align',{align:graph.master.align, bpm:graph.master.bpm}); };
$('#alignBpm').onchange=e=>{ if(!graph) return; graph.master.bpm=Math.max(70,Math.min(160,parseInt(e.target.value)||120));
  e.target.value=graph.master.bpm; op('set_align',{align:graph.master.align, bpm:graph.master.bpm}); };
$('#bpm').oninput=e=>{ st.bpm=+e.target.value; $('#bpmVal').textContent=st.bpm; };
$('#bpm').onchange=()=>{ renderNodeThumb(selId); op('set_tempo',{node:dispName(selNode()), bpm:st.bpm}); };
$('#swing').oninput=e=>{ st.swing=+e.target.value/100; $('#swVal').textContent=e.target.value+'%'; };
$('#swing').onchange=()=>op('set_tempo',{node:dispName(selNode()), swing:st.swing});
$('#moodDark').onclick=()=>setMood('dark'); $('#moodBright').onclick=()=>setMood('bright');
function setMood(m){ st.mood=m; curMood=m; $('#moodDark').classList.toggle('on',m==='dark');
  $('#moodBright').classList.toggle('on',m==='bright'); buildBoard(); renderNodeThumb(selId); op('set_mood',{node:dispName(selNode()), mood:m}); }

/* build the song sequence by walking the graph (random branch on multi-out) */
function buildSong(){
  const out=[]; const realNodes=graph.nodes.filter(n=>!n.ghost);
  let cur=realNodes.find(n=>n.id===graph.startId) || realNodes[0]; let guard=0; const MAXSEG=8;
  const edgesFrom=id=>graph.edges.filter(e=>e.from===id && !nodeById(e.to)?.ghost);
  const align=graph.master&&graph.master.align?graph.master.bpm:null;
  while(cur && guard++<MAXSEG){
    const s=Object.assign({}, cur.state, {reps:cur.reps||1, _id:cur.id});
    if(align) s.bpm=align;
    out.push(s);
    const es=edgesFrom(cur.id); if(!es.length) break;
    const nx=es[Math.floor(rng()*es.length)]; cur=nodeById(nx.to);
  }
  return out;
}

/* ================= Loop Graph rendering ================= */
const gArea=$('#graphArea');
function renderGraph(){
  // nodes
  [...gArea.querySelectorAll('.gnode')].forEach(n=>n.remove());
  graph.nodes.forEach(n=>{
    const el=document.createElement('div'); el.className='gnode'+(n.id===selId?' selected':'')+(n.id===graph.startId?' startNode':'')+(n.ghost?' ghostNode':'');
    el.style.left=n.x+'px'; el.style.top=n.y+'px'; el.dataset.id=n.id;
    const cv=document.createElement('canvas'); drawThumb(cv, n.state); el.appendChild(cv);
    const nm=document.createElement('div'); nm.className='nname'; nm.textContent=dispName(n); el.appendChild(nm);
    if(n.ghost){
      const gb=document.createElement('div'); gb.className='ghostBtns';
      gb.innerHTML=`<button data-acc="${n.id}">✓</button><button data-rej="${n.id}">✗</button>`;
      el.appendChild(gb);
    } else {
      const meta=document.createElement('div'); meta.className='nmeta';
      meta.innerHTML=`<button data-reps="${n.id}">×${n.reps}</button><button data-play="${n.id}">▶</button><button data-start="${n.id}">🏁</button>`;
      el.appendChild(meta);
      const port=document.createElement('div'); port.className='port'; port.dataset.port=n.id; el.appendChild(port);
      const x=document.createElement('div'); x.className='nx'; x.dataset.del=n.id; x.textContent='✕'; el.appendChild(x);
    }
    gArea.appendChild(el);
  });
  renderEdges();
}
function renderEdges(){
  const svg=$('#edgeSvg'); const r=gArea.getBoundingClientRect();
  let defs='<defs><marker id="ah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0L8,4L0,8z" fill="var(--cable)"/></marker></defs>';
  let paths='';
  graph.edges.forEach((e,i)=>{
    const a=gArea.querySelector(`.gnode[data-id="${e.from}"]`), b=gArea.querySelector(`.gnode[data-id="${e.to}"]`);
    if(!a||!b) return;
    const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect();
    const x1=ar.right-r.left, y1=ar.top-r.top+ar.height/2, x2=br.left-r.left, y2=br.top-r.top+br.height/2;
    const mx=(x1+x2)/2; const ghost=nodeById(e.to)?.ghost;
    const d=`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    paths+=`<path d="${d}" fill="none" stroke="${ghost?'rgba(224,159,62,.5)':'var(--cable)'}" stroke-width="2.5" ${ghost?'stroke-dasharray="5 4"':''} marker-end="url(#ah)"/>`;
    paths+=`<path class="hit" d="${d}" fill="none" stroke="transparent" stroke-width="12" data-edge="${i}"/>`;
  });
  svg.innerHTML=defs+paths;
}
function drawThumb(cv,pat){ const rows=SECTIONS.reduce((a,s)=>a+s.rows,0); cv.width=STEPS; cv.height=rows;
  const ctx=cv.getContext('2d'); ctx.fillStyle='#14120c'; ctx.fillRect(0,0,STEPS,rows);
  const colors={drums:'#ff5c47',k808:'#ff9e3d',keys:'#3fe8a0',bars:'#c990ff'}; let y=0;
  SECTIONS.forEach(sec=>{ ctx.fillStyle=colors[sec.id]; for(let r=0;r<sec.rows;r++) for(let c=0;c<STEPS;c++)
    if(pat.grids?.[sec.id]?.[r]?.[c]) ctx.fillRect(c,y+r,1,1); y+=sec.rows; }); }
function renderNodeThumb(id){ const el=gArea.querySelector(`.gnode[data-id="${id}"] canvas`); if(el) drawThumb(el, nodeById(id).state); }
function setActiveNode(id){ [...gArea.querySelectorAll('.gnode')].forEach(el=>el.classList.toggle('activeNode', el.dataset.id===id)); }

/* graph interactions: select, drag-move, edge-drag, controls */
let dragging=null, edgeDrag=null;
gArea.addEventListener('pointerdown',e=>{
  const port=e.target.closest('.port');
  if(port){ e.preventDefault(); edgeDrag={from:port.dataset.port}; return; }
  const node=e.target.closest('.gnode'); if(!node) return;
  if(e.target.closest('button')||e.target.closest('.nx')) return;
  const n=nodeById(node.dataset.id);
  if(n.ghost){ selectNode(n.id); return; }
  selectNode(n.id);
  const r=gArea.getBoundingClientRect(); const ox=e.clientX-r.left-n.x, oy=e.clientY-r.top-n.y;
  dragging={id:n.id, ox, oy, moved:false};
});
window.addEventListener('pointermove',e=>{
  if(dragging){ const n=nodeById(dragging.id); const r=gArea.getBoundingClientRect();
    n.x=Math.max(0,Math.min(gArea.clientWidth-136, e.clientX-r.left-dragging.ox));
    n.y=Math.max(0,Math.min(gArea.clientHeight-70, e.clientY-r.top-dragging.oy));
    dragging.moved=true;
    const el=gArea.querySelector(`.gnode[data-id="${n.id}"]`); if(el){ el.style.left=n.x+'px'; el.style.top=n.y+'px'; }
    renderEdges();
  }
});
window.addEventListener('pointerup',e=>{
  if(edgeDrag){ const node=document.elementFromPoint(e.clientX,e.clientY)?.closest('.gnode');
    if(node && node.dataset.id!==edgeDrag.from){ addEdge(edgeDrag.from, node.dataset.id); } edgeDrag=null; }
  if(dragging){ if(dragging.moved) op('move',{node:dispName(nodeById(dragging.id))}); dragging=null; }
});
gArea.addEventListener('click',e=>{
  const acc=e.target.dataset?.acc, rej=e.target.dataset?.rej, del=e.target.dataset?.del,
        reps=e.target.dataset?.reps, play=e.target.dataset?.play, start=e.target.dataset?.start,
        edge=e.target.dataset?.edge;
  if(acc){ acceptGhostNode(acc); }
  else if(rej){ rejectGhostNode(rej); }
  else if(del){ removeNode(del); }
  else if(reps){ const n=nodeById(reps); n.reps=n.reps>=4?1:n.reps*2; renderGraph(); op('set_reps',{node:dispName(n), reps:n.reps}); }
  else if(play){ selectNode(play); stopLoop(); startLoop('node'); }
  else if(start){ graph.startId=start; renderGraph(); op('set_start',{node:dispName(nodeById(start))}); }
  else if(edge!=null){ graph.edges.splice(+edge,1); renderGraph(); op('remove_edge',{}); }
});
function addEdge(from,to){ if(graph.edges.some(x=>x.from===from&&x.to===to)) return;
  graph.edges.push({from,to}); renderGraph(); op('add_edge',{from:dispName(nodeById(from)), to:dispName(nodeById(to))}); }
/* node display name — language-neutral keys resolved at render time so
   switching language re-labels app-generated names. Legacy/persisted nodes
   with only a baked `name` fall back to it. */
function dispName(n){
  if(!n) return '';
  if(n.custom && n.name) return n.name;
  if(n.k==='section') return t('node.section',{letter:n.letter||'?'});
  if(n.k==='variant') return dispBase(n)+vSuffix(n.vkind);
  if(n.k) return t('node.'+n.k);
  return n.name||'';
}
function dispBase(n){
  if(n.baseK==='section') return t('node.section',{letter:n.baseLetter||'?'});
  if(n.baseK) return t('node.'+n.baseK);
  return n.baseName||'';
}
function addNode(state, x, y, opts={}){
  graph.counter=(graph.counter||graph.nodes.length)+1;
  const id='n'+graph.counter;
  const node={id, x:x??60, y:y??40, reps:opts.reps||2, ghost:!!opts.ghost, state,
    k:opts.k, letter:opts.letter, vkind:opts.vkind, baseK:opts.baseK, baseLetter:opts.baseLetter, baseName:opts.baseName,
    custom:opts.custom, name:opts.name};
  if(!node.k && !node.name){ node.k='section'; node.letter=String.fromCharCode(64+((graph.counter-1)%26+1)); }
  graph.nodes.push(node); if(!graph.startId) graph.startId=id;
  return node;
}
function removeNode(id){ const n=nodeById(id); graph.nodes=graph.nodes.filter(x=>x.id!==id);
  graph.edges=graph.edges.filter(e=>e.from!==id&&e.to!==id);
  if(graph.startId===id) graph.startId=graph.nodes[0]?.id||null;
  if(selId===id && graph.nodes[0]) selectNode(graph.nodes[0].id, {silent:true});
  renderGraph(); op('remove_node',{node:dispName(n)}); }
$('#addNodeBtn').onclick=()=>{ if(!loop) return;
  const n=addNode(starterState(), 60+(graph.nodes.length%4)*150, 30+Math.floor(graph.nodes.length/4)*130,
    {reps:2, k:'section', letter:String.fromCharCode(64+(graph.nodes.length%26))});
  selectNode(n.id); renderGraph(); op('add_node',{node:dispName(n)}); toast(t('toast.addSection',{name:dispName(n)})); };

/* ================= Crew agents (pattern ghost into selected node) ================= */
let ghost=null;
const AGENTS={ beat:{name:'@Beat',em:'🥁',color:'var(--drum)'}, k808:{name:'@808',em:'🔊',color:'var(--i808)'},
  hook:{name:'@Hook',em:'🎹',color:'var(--keys)'}, flow:{name:'@Flow',em:'🎤',color:'var(--bars)'},
  arranger:{name:'@Arranger',em:'✨',color:'var(--accent)'} };
function mk(rows){ return Array.from({length:rows},()=>Array(STEPS).fill(false)); }
function chatSay(a,t){ const c=$('#chat'); const m=document.createElement('div'); m.className='msg';
  m.innerHTML=`<div class="av">${a.em}</div><div><div class="who" style="color:${a.color}">${a.name}</div>${t}</div>`; c.appendChild(m); c.scrollTop=c.scrollHeight; }
function chatSys(t){ const c=$('#chat'); const m=document.createElement('div'); m.className='msg sys'; m.textContent=t; c.appendChild(m); c.scrollTop=c.scrollHeight; }
function setGhost(section,grid,key,msg){ if(ghost) clearGhost(false);
  ghost={section,grid,agent:key}; paintAll(); $('#proposalBar').classList.add('show'); chatSay(AGENTS[key],msg);
  if(!playing&&loop) startLoop('node'); }
function clearGhost(accept){ if(!ghost) return; const key=ghost.agent, sec=ghost.section, grid=ghost.grid;
  if(accept){ const g=st.grids[sec]; grid.forEach((row,r)=>row.forEach((v,c)=>{ if(v) g[r][c]=true; }));
    chatSay(AGENTS[key],t('chat.accepted')); ghost=null; $('#proposalBar').classList.remove('show'); paintAll(); renderNodeThumb(selId);
    op('agent_fill',{node:dispName(selNode()), section:sec, agent:AGENTS[key].name}); }
  else { chatSay(AGENTS[key],t('chat.erased')); ghost=null; $('#proposalBar').classList.remove('show'); paintAll(); } }
$('#acceptBtn').onclick=()=>clearGhost(true); $('#rejectBtn').onclick=()=>clearGhost(false);
$$('.agentBtn').forEach(b=>b.onclick=()=>{ if(!loop) return; ({beat:propBeat,k808:prop808,hook:propHook,flow:propFlow})[b.dataset.agent](); });
function propBeat(){ const g=mk(5), style=pick(['trap','boom']);
  if(style==='trap'){ [0,6,10].forEach(s=>g[0][s]=true); [4,12].forEach(s=>g[2][s]=true);
    for(let s=0;s<16;s++) if(s%2===0||rng()<.4) g[3][s]=true; if(rng()<.7){[6,7,14,15].forEach(s=>g[3][s]=true);} }
  else { [0,7,10].forEach(s=>g[0][s]=true); [4,12].forEach(s=>g[1][s]=true); for(let s=0;s<16;s+=2)g[3][s]=true; }
  setGhost('drums',g,'beat', style==='trap'?t('chat.beatTrap'):t('chat.beatBoom')); }
function prop808(){ const g=mk(6), roots=curMoodRoots(); for(let s=0;s<STEPS;s+=4){ const row=roots[(s/4)%roots.length];
  g[row][s]=true; if(rng()<.6){ for(let k=1;k<pick([2,3,4]);k++) if(s+k<16) g[row][s+k]=true; } }
  setGhost('k808',g,'k808',t('chat.bass808')); }
function propHook(){ const g=mk(8); let row=pick([2,3,4]);
  for(let s=0;s<STEPS;s++){ const strong=s%4===0;
    if(strong&&rng()<.85){ row=Math.max(0,Math.min(7,row+pick([-2,-1,0,1,2]))); g[row][s]=true; }
    else if(!strong&&rng()<.3){ row=Math.max(0,Math.min(7,row+pick([-1,1]))); g[row][s]=true; } }
  setGhost('keys',g,'hook',t('chat.hook')); }
function propFlow(){ const g=mk(1); pick([[0,3,4,7,8,11,12,14],[0,2,4,6,8,10,12,14],[0,3,6,8,11,14]]).forEach(s=>g[0][s]=true);
  setGhost('bars',g,'flow',t('chat.flow')); }
function curMoodRoots(){ return st.mood==='dark'?[5,3,1,0]:[5,4,2,0]; }

/* ================= @Arranger — ghost variant NODES ================= */
const VARIANTS=[{kind:'variation'},{kind:'lift'},{kind:'break'}];
function vSuffix(k){ return t('variant.'+(k==='break'?'brk':k)); }
function vDesc(k){ return t('variant.'+(k==='variation'?'varDesc':k==='lift'?'liftDesc':'brkDesc')); }
$('#arrangeBtn').onclick=()=>{ if(!loop) return; const base=selNode(); if(!base||base.ghost){ toast(t('toast.pickSection')); return; }
  const defs=[...VARIANTS].sort(()=>rng()-.5).slice(0,2);
  defs.forEach((d,i)=>{ const v=addNode(mutate(base.state,d.kind),
      Math.min(base.x+170, gArea.clientWidth-140), Math.max(0,Math.min(gArea.clientHeight-70, base.y+(i?90:-90))),
      {ghost:true, reps:base.reps, k:'variant', vkind:d.kind, baseK:base.k, baseLetter:base.letter, baseName:base.name});
    graph.edges.push({from:base.id, to:v.id}); });
  renderGraph(); chatSay(AGENTS.arranger, t('chat.arrange',{name:dispName(base), list:defs.map(d=>vSuffix(d.kind).trim()+'('+vDesc(d.kind)+')').join(i18next.language==='zh'?'；':'; ')}));
  op('arrange',{node:dispName(base), variants:defs.map(d=>vSuffix(d.kind).trim())}); };
function mutate(s,kind){ const n=JSON.parse(JSON.stringify(s));
  if(kind==='lift'){ const k=n.grids.keys; for(let r=n.grids.keys.length-1;r>0;r--) k[r]=k[r-1].slice(); k[0]=Array(STEPS).fill(false);
    for(let s2=0;s2<16;s2++) if(s2%2===0) n.grids.drums[3][s2]=true; }
  else if(kind==='break'){ n.grids.drums=n.grids.drums.map((r,i)=>i===0?r.map((v,c)=>c%8===0&&v):Array(STEPS).fill(false));
    n.grids.keys=n.grids.keys.map(r=>r.map((v,c)=>v&&c<8)); }
  else { const k=n.grids.keys; for(let r=0;r<k.length;r++) for(let c=0;c<STEPS;c++) if(k[r][c]&&rng()<.5){ k[r][c]=false; const nr=Math.max(0,Math.min(7,r+pick([-1,1]))); k[nr][c]=true; }
    for(let c=1;c<16;c+=4) if(rng()<.6) n.grids.drums[3][c]=true; }
  return n; }
function acceptGhostNode(id){ const n=nodeById(id); if(!n) return; n.ghost=false; renderGraph();
  chatSay(AGENTS.arranger,t('chat.nodeIn',{name:dispName(n)})); op('add_node',{node:dispName(n), via:'@Arranger'}); }
function rejectGhostNode(id){ const n=nodeById(id); graph.nodes=graph.nodes.filter(x=>x.id!==id);
  graph.edges=graph.edges.filter(e=>e.from!==id&&e.to!==id); renderGraph(); chatSay(AGENTS.arranger,t('chat.erased')); }

/* ================= per-song history ================= */
const HIDDEN_OPS = new Set(['move','update_graph']);
function opLine(o){ const who=(o.actorKind==='agent'?'🤖':'🧑')+' '+(o.actorName||o.actorId);
  const verb=t('op.'+o.action, {defaultValue:o.action}); let extra='';
  if(o.payload){ const p=o.payload;
    if(p.node) extra=' · '+p.node; if(p.section) extra+=' / '+p.section.toUpperCase();
    if(p.agent) extra+=' ('+p.agent+')'; if(p.via) extra+=' ('+p.via+')';
    if(p.mood) extra+=' · '+p.mood; if(p.word) extra+=' · "'+p.word+'"';
    if(p.to&&p.from) extra=' · '+p.from+'→'+p.to; if(p.fromTitle) extra=' · '+p.fromTitle;
    if(p.variants) extra+=' · '+p.variants.join('/'); }
  return {who, verb, extra, kind:o.actorKind}; }
async function refreshOps(){ if(!loop) return; let ops=[]; try{ ops=await API.getOps(loop.id); }catch(e){}
  const shown=ops.filter(o=>!HIDDEN_OPS.has(o.action));
  const box=$('#opList'); box.innerHTML='';
  if(!shown.length){ box.innerHTML='<div class="empty">'+t('history.empty')+'</div>'; }
  shown.slice().reverse().forEach(o=>{ const L=opLine(o); const d=document.createElement('div'); d.className='opline '+L.kind;
    d.innerHTML=`<span class="who">${L.who}</span> ${L.verb}<span class="ex">${L.extra}</span>`; box.appendChild(d); });
  $('#opCount').textContent=shown.length; }

/* ================= song lifecycle ================= */
async function newSong(){ const rec=await API.createLoop({ title:nextTitle(), graph:freshGraph() });
  useLoop(rec); toast(t('toast.newSong',{title:rec.title})); }
function freshGraph(){
  const a=starterState(), b=mutate(a,'lift');
  return { nodes:[{id:'n1',k:'verse',x:50,y:118,reps:2,state:a},
                  {id:'n2',k:'chorus',x:300,y:40,reps:2,state:b}],
           edges:[{from:'n1',to:'n2'},{from:'n2',to:'n1'}], startId:'n1', counter:2 }; }
$('#addNodeBtn'); // wired above
$('#starterBtn').onclick=()=>{ if(!loop) return;
  Object.assign(selNode().state, randomState());          // roll a fresh random pattern
  selectNode(selId,{silent:true}); renderNodeThumb(selId); // refresh canvas + BPM/Swing/mood UI
  op('paint',{node:dispName(selNode()), sections:['drums','k808','keys'], on:true, random:true});
  if(!playing) startLoop('node'); };
$('#clearBtn').onclick=()=>{ if(!loop) return; st.grids=emptyGrids(); st.bars={}; buildBoard(); renderNodeThumb(selId); op('clear',{node:dispName(selNode())}); };
$('#publishBtn').onclick=async()=>{ if(!loop) return;
  const any=graph.nodes.some(n=>SECTIONS.some(s=>n.state.grids[s.id].some(r=>r.some(v=>v))));
  if(!any && !loop.published){ toast(t('toast.emptyCanvas')); return; }
  const rec=await API.publish(loop.id, !loop.published); loop.published=rec.published;
  $('#publishBtn').textContent=loop.published?t('board.published'):t('board.publish'); $('#publishBtn').classList.toggle('on',loop.published);
  toast(loop.published?t('toast.publishOk'):t('toast.unpublishOk')); refreshFeed(); refreshOps(); };
$('#forkBtn').onclick=async()=>{ if(!loop) return; await doFork(loop.id, loop.title); };
async function doFork(id, title){ const rec=await API.fork(id, title? title+' · '+t('node.flipSuffix'):undefined);
  rec._forkedTitle=title; useLoop(rec); toast(t('toast.flipOk')); refreshFeed(); window.scrollTo({top:0,behavior:'smooth'}); }
$('#wavBtn').onclick=async()=>{ if(!loop) return; ensureAudio(); toast(t('toast.renderWav'));
  const buf=await renderState(st,2); const a=document.createElement('a'); a.href=URL.createObjectURL(bufToWav(buf)); a.download=(dispName(selNode())||'loop')+'.wav'; a.click(); };
$('#songWavBtn').onclick=async()=>{ if(!loop) return; ensureAudio(); const seq=buildSong(); if(!seq.length){ toast(t('toast.noSections')); return; }
  toast(t('toast.renderSong')); const buf=await renderSong(seq); const a=document.createElement('a'); a.href=URL.createObjectURL(bufToWav(buf)); a.download=(loop.title||'song')+'.wav'; a.click(); };

/* ================= Jam Feed ================= */
let feedAudio=null, feedPlayingId=null;
async function refreshFeed(){ let ls=[]; try{ ls=await API.listLoops({published:true}); }catch(e){}
  const wrap=$('#cards'); wrap.innerHTML='';
  if(!ls.length){ wrap.innerHTML='<div class="empty">'+t('feed.empty')+'</div>'; return; }
  ls.forEach(item=>{ const g=normalizeGraph(item.graph); const start=g.nodes.find(n=>n.id===g.startId)||g.nodes[0];
    const card=document.createElement('div'); card.className='card';
    const cv=document.createElement('canvas'); drawThumb(cv, start.state); card.appendChild(cv);
    const titleEl=document.createElement('div'); titleEl.className='t'; titleEl.textContent=item.title; card.appendChild(titleEl);
    const meta=document.createElement('div'); meta.className='meta';
    meta.innerHTML=`${start.state.bpm||88} BPM · ${(item.authorKind==='agent'?'🤖':'🧑')} ${item.authorName||item.authorId}`+
      (item.forkedFrom?` · <span class="from">${t('feed.flipped')}</span>`:'');
    card.appendChild(meta);
    const nd=document.createElement('div'); nd.className='nodes'; nd.textContent=t('feed.sections',{n:g.nodes.filter(n=>!n.ghost).length}); card.appendChild(nd);
    const btns=document.createElement('div'); btns.className='btns';
    const pb=document.createElement('button'); pb.className='mini'; pb.textContent=feedPlayingId===item.id?t('feed.stop'):t('feed.preview'); pb.onclick=()=>playFeed(item,g,pb);
    const fb=document.createElement('button'); fb.className='mini'; fb.textContent=t('feed.flip'); fb.onclick=()=>doFork(item.id,item.title);
    btns.appendChild(pb); btns.appendChild(fb); card.appendChild(btns); wrap.appendChild(card); });
}
async function playFeed(item,g,btn){ ensureAudio(); if(feedAudio){ feedAudio.stop(); feedAudio=null; }
  if(feedPlayingId===item.id){ feedPlayingId=null; refreshFeed(); return; }
  if(playing) stopLoop(); btn.textContent='…';
  const seq=g.nodes.filter(n=>!n.ghost).length? buildSongFrom(g) : [Object.assign({},g.nodes[0].state,{reps:2})];
  const buf=await renderSong(seq); const src=AC.createBufferSource(); src.buffer=buf; src.connect(AC.destination);
  src.onended=()=>{ if(feedPlayingId===item.id){ feedPlayingId=null; refreshFeed(); } };
  src.start(); feedAudio=src; feedPlayingId=item.id; refreshFeed(); }
function buildSongFrom(g){ const out=[]; let cur=g.nodes.find(n=>n.id===g.startId&&!n.ghost)||g.nodes.find(n=>!n.ghost); let guard=0; const MAXSEG=8;
  const ef=id=>g.edges.filter(e=>e.from===id && !g.nodes.find(n=>n.id===e.to)?.ghost);
  const align=g.master&&g.master.align?g.master.bpm:null;
  while(cur&&guard++<MAXSEG){ const s=Object.assign({},cur.state,{reps:cur.reps||1}); if(align)s.bpm=align; out.push(s); const es=ef(cur.id); if(!es.length) break;
    cur=g.nodes.find(n=>n.id===es[Math.floor(rng()*es.length)].to); } return out; }

/* ================= presets ================= */
const NAME_A=['Neon','Rainy','Midnight','Pixel','Velvet','Chrome','Slow','Amber','Static','Late'];
const NAME_B=['Loop','Pixels','Nights','Blocks','Tape','Bounce','Sketch','Vibe','Session','Set'];
let titleN=0; function nextTitle(){ titleN++; return pick(NAME_A)+' '+pick(NAME_B); }
function starterState(){ const s=emptyState(); const G=s.grids;
  [0,6,10].forEach(x=>G.drums[0][x]=true); [4,12].forEach(x=>G.drums[1][x]=true);   // kick + snare
  for(let x=0;x<16;x++) if(x%2===0) G.drums[3][x]=true; [6,7].forEach(x=>G.drums[3][x]=true); // hats + roll
  G.k808[5][0]=true; G.k808[5][1]=true; G.k808[3][8]=true; G.k808[3][9]=true;         // 808
  [0,4,7,11].forEach((x,i)=>G.keys[[3,2,4,3][i]][x]=true);                            // keys
  s.bars={0:'yeah',4:'flow',8:'on',12:'beat'}; [0,4,8,12].forEach(x=>G.bars[0][x]=true);
  return s; }
/* 🎲 Feeling lucky — a fresh but reliably listenable pattern each click.
   Guardrails: solid kick/snare backbone, steady hats, a 4-bar root
   progression that drives BOTH the 808 and the keys so they cohere
   (everything stays pentatonic, so there are no clashing notes). */
function randomState(){
  rng = mulberry32((Math.random()*4294967296)>>>0);   // genuine luck each click
  const cl=(v,a,b)=>Math.max(a,Math.min(b,v));
  const s=emptyState(); const G=s.grids;
  s.mood = rng()<.5?'dark':'bright'; curMood=s.mood;
  s.bpm  = pick([84,88,90,92,96,100]);                // groove-friendly range
  s.swing= pick([0.08,0.12,0.16]);

  // --- drums: guaranteed groove ---
  const kickStyle=pick(['four','boombap','trap']);
  if(kickStyle==='four')       [0,4,8,12].forEach(x=>G.drums[0][x]=true);
  else if(kickStyle==='boombap'){ [0,10].forEach(x=>G.drums[0][x]=true); if(rng()<.6)G.drums[0][7]=true; }
  else                         [0,3,6,10].forEach(x=>G.drums[0][x]=true);
  G.drums[0][0]=true;                                 // always a downbeat kick
  [4,12].forEach(x=>G.drums[1][x]=true);              // snare on the backbeat
  const hatStep = rng()<.55?2:1;                      // steady 8ths or 16ths
  for(let x=0;x<16;x+=hatStep) G.drums[3][x]=true;
  if(rng()<.4)[14,15].forEach(x=>G.drums[3][x]=true); // tiny end-of-bar roll
  if(rng()<.35)[4,12].forEach(x=>G.drums[2][x]=true); // clap doubling the snare
  if(rng()<.25)G.drums[4][14]=true;                   // occasional open hat

  // --- one 4-bar progression drives bass + melody ---
  const prog = pick([[0,3,1,2],[0,2,3,1],[0,1,3,2],[0,0,2,3]]);   // chord index per bar
  const bassRows = s.mood==='dark'?[5,3,1,0]:[5,4,2,0];           // low 808 rows per chord
  prog.forEach((c,bar)=>{ const row=bassRows[c%bassRows.length], start=bar*4;
    G.k808[row][start]=true; if(rng()<.6)G.k808[row][start+2]=true; });

  // --- keys: a phrase — a note on every downbeat, small stepwise passing notes ---
  let krow=pick([3,4,5]);
  for(let x=0;x<16;x++){ const strong=x%4===0;
    if(strong){ krow=cl(krow+pick([-2,-1,0,0,1,2]),1,7); G.keys[krow][x]=true; }
    else if(rng()<.35){ krow=cl(krow+pick([-1,1]),1,7); G.keys[krow][x]=true; } }
  return s; }

/* ================= identity (Login-with-Raft) ================= */
const TOKEN_KEY='rap.token';
async function resolveIdentity(){ if(API.MOCK) return true;
  const params=new URLSearchParams(location.search); const tok=localStorage.getItem(TOKEN_KEY); if(tok) RAP.token=tok;
  const devMode=!!(params.get('dev'));
  try{ const me=await API.me();
    RAP.actor={ id:me.id||me.sub||me.actorId, kind:(me.kind||me.type)==='agent'?'agent':'human',
      name:me.name||me.displayName||me.id||me.sub, handle:me.handle||me.username||me.name||me.sub };
    renderActor(); return true;
  }catch(e){ if(/→ 401/.test(e.message)&&!devMode){ showLogin(); return false; } return true; } }
function showLogin(){ const m=document.querySelector('main'); m.style.display='block';
  m.innerHTML=`<div style="grid-column:1/-1;text-align:center;padding:72px 20px">
    <div class="logo" style="font-size:28px">musik<b>.build</b></div>
    <div style="color:var(--dim);font-size:13px;margin:16px 0 26px">${t('login.blurb')}</div>
    <a href="/login"><button class="primary" style="font-size:15px;padding:12px 26px">${t('login.cta')}</button></a></div>`; }

/* ================= boot ================= */
/* re-render dynamic (t()-driven) content on language switch */
window.onLangChange = function(){
  renderActor();
  if(!loop) return;   // login gate: static data-i18n already re-applied
  $('#publishBtn').textContent = loop.published? t('board.published') : t('board.publish');
  selectNode(selId, {silent:true});   // node name + board in new language
  renderGraph(); refreshOps(); refreshFeed();
  $('#chat').innerHTML=''; chatSys(t('chat.ready')); chatSay(AGENTS.beat, t('crew.greet'));
};
$('#langBtn').addEventListener('click', ()=>{ toggleLang(); });

async function boot(){
  await initI18n();
  renderActor();
  $('#modeTag').textContent = API.MOCK ? 'MOCK · localStorage' : ('LIVE · '+API.base);
  $('#modeTag').className='modetag '+(API.MOCK?'mock':'live');
  if(!(await resolveIdentity())) return;
  if(API.MOCK) await seedIfEmpty();
  const ls=await API.listLoops();
  const mine=ls.find(l=>l.authorId===RAP.actor.id);
  if(mine){ const full=await API.getLoop(mine.id); useLoop(full); } else { await newSong(); }
  refreshFeed();
  chatSys(t('chat.ready'));
  chatSay(AGENTS.beat,t('crew.greet'));
}
async function seedIfEmpty(){ const ls=await API.listLoops(); if(ls.length) return;
  const prev=RAP.actor;
  setActor({id:'agent:ed',kind:'agent',name:'@Ed'});
  const g=freshGraph(); g.nodes.push({id:'n2',k:'chorus',x:250,y:30,reps:2,state:mutate(g.nodes[0].state,'lift')});
  g.edges.push({from:'n1',to:'n2'}); g.edges.push({from:'n2',to:'n1'}); g.counter=2;
  const a=await API.createLoop({title:'Concrete Bars', graph:g}); await API.publish(a.id,true);
  setActor({id:'human:alice',kind:'human',name:'Alice'});
  const b=await API.fork(a.id,'Concrete Bars'); const bg=normalizeGraph(b.graph); bg.nodes[0].state.bpm=96;
  await API.patchLoop(b.id,'set_tempo',{node:t('node.verse',{},'en')||'A',bpm:96},b.graph); await API.publish(b.id,true);
  setActor(prev);
}
boot();
