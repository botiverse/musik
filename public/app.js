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
function toast(m){ const el=$('#toast'); el.textContent=m; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),2400); }

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
  $('#songTitle').textContent = loop.title || '—';
  const ff = loop.forkedFrom;
  $('#lineage').style.display = ff? 'block':'none';
  if(ff) $('#lineageName').textContent = loop._forkedTitle || loop.title;
  $('#publishBtn').textContent = loop.published? t('board.published') : t('board.publish');
  $('#publishBtn').classList.toggle('on', !!loop.published);
  syncAlignUI();
  panX=0; panY=0;                      // reset graph view on load
  selectNode(selId, {silent:true});
  renderGraph(); refreshOps();
}
function syncAlignUI(){ if(!graph||!graph.master) return;
  $('#alignChk').checked=graph.master.align; $('#alignBpm').disabled=!graph.master.align; $('#alignBpm').value=graph.master.bpm; }
function normalizeGraph(g){
  if(g && typeof g==='object' && !Array.isArray(g) && Array.isArray(g.nodes) && g.nodes.length){
    const ids=new Set(), nodes=[];
    g.nodes.slice(0,256).forEach((raw,index)=>{
      if(!raw || typeof raw!=='object' || Array.isArray(raw)) return;
      let id=typeof raw.id==='string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) && !ids.has(raw.id)
        ? raw.id : `legacy_${index+1}`;
      let suffix=1;
      while(ids.has(id)) id=`legacy_${index+1}_${suffix++}`;
      ids.add(id);
      const n={...raw,id,state:ensureShape(raw.state)};
      n.x=Number.isFinite(n.x)?Math.max(-100000,Math.min(100000,n.x)):40;
      n.y=Number.isFinite(n.y)?Math.max(-100000,Math.min(100000,n.y)):40;
      n.reps=Number.isInteger(n.reps)?Math.max(1,Math.min(64,n.reps)):2;
      n.ghost=n.ghost===true;
      nodes.push(n);
    });
    if(nodes.length){
      const edges=(Array.isArray(g.edges)?g.edges:[]).slice(0,1024).filter(e=>
        e && typeof e==='object' && !Array.isArray(e) &&
        typeof e.from==='string' && typeof e.to==='string' && ids.has(e.from) && ids.has(e.to));
      const startId=typeof g.startId==='string' && ids.has(g.startId)?g.startId:nodes[0].id;
      const counter=Number.isInteger(g.counter) && g.counter>=0 && g.counter<=1000000000
        ? g.counter : nodes.length;
      const rawMaster=g.master && typeof g.master==='object' && !Array.isArray(g.master)?g.master:{};
      const master={...rawMaster,align:rawMaster.align===true};
      master.bpm=Number.isFinite(rawMaster.bpm)
        ? Math.max(20,Math.min(400,rawMaster.bpm))
        : nodes[0].state.bpm;
      return {...g,nodes,edges,startId,counter,master};
    }
  }
  // migrate a bare/legacy pattern into a single node
  const pat = ensureShape((g && g.grids) ? g : (g && g.nodes && g.nodes[0] && g.nodes[0].state) || starterState());
  return { nodes:[{id:'n1', k:'verse', x:40, y:110, reps:2, state:pat}], edges:[], startId:'n1', counter:1,
           master:{align:false, bpm:(pat.bpm)||120} };
}
function ensureShape(s){
  if(!s || typeof s!=='object' || Array.isArray(s)) s={};
  const source=s.grids && typeof s.grids==='object' && !Array.isArray(s.grids)?s.grids:{};
  const grids={};
  SECTIONS.forEach(sec=>{
    const rows=Array.isArray(source[sec.id])?source[sec.id]:[];
    grids[sec.id]=Array.from({length:sec.rows},(_,r)=>{
      const row=Array.isArray(rows[r])?rows[r]:[];
      return Array.from({length:STEPS},(_,c)=>row[c]===true);
    });
  });
  s.grids=grids;
  const sourceBars=s.bars && typeof s.bars==='object' && !Array.isArray(s.bars)?s.bars:{};
  s.bars={};
  Object.entries(sourceBars).slice(0,STEPS).forEach(([step,word])=>{
    const index=Number(step);
    if(/^\d{1,2}$/.test(step) && Number.isInteger(index) && index>=0 && index<STEPS && typeof word==='string'){
      s.bars[index]=word.slice(0,10);
    }
  });
  s.bpm=Number.isFinite(s.bpm)?Math.max(20,Math.min(400,s.bpm)):88;
  s.swing=Number.isFinite(s.swing)?Math.max(0,Math.min(1,s.swing)):.14;
  if(s.mood!=='dark'&&s.mood!=='bright') s.mood='dark';
  return s;
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
let mutationQueue=Promise.resolve();
let dirtyAfterFailedSave=false;
function enqueueMutation(run){
  const task=mutationQueue.then(run);
  mutationQueue=task.catch(()=>{});
  return task;
}
async function persistDirtyCurrentLoop(){
  if(!dirtyAfterFailedSave || !loop) return;
  const saved=await API.patchLoop(loop.id,'update_graph',{recovery:true},loop.graph,loop.version);
  loop.version=saved.version; dirtyAfterFailedSave=false; refreshOps();
}
function op(action, payload){
  const loopId=loop&&loop.id;
  return enqueueMutation(async()=>{
    if(!loop || loop.id!==loopId) return;
    try{ const saved=await API.patchLoop(loop.id, action, payload, loop.graph, loop.version);
      loop.version=saved.version; dirtyAfterFailedSave=false; refreshOps(); }
    catch(e){
      if(e.status===409){ dirtyAfterFailedSave=false; toast(t('toast.saveFail',{err:'version conflict'})); await reloadCurrentLoop(); }
      if(/→ 403/.test(e.message)) toast(t('toast.notYours'));
      else if(e.status!==409){ dirtyAfterFailedSave=true; toast(t('toast.saveFail',{err:e.message})); }
    }
  });
}
async function reloadCurrentLoop(){ if(!loop) return; try{ useLoop(await API.getLoop(loop.id)); }catch(e){} }

/* ================= account menu (handle + logout; demo-switch in mock) ================= */
function renderActor(){ const a=RAP.actor;
  $('#actorChip').textContent = (a.kind==='agent'?'🤖':'🧑')+' '+a.name;
  $('#actorChip').className = 'chip '+(a.kind==='agent'?'agent':'human');
  $('#acctHandle').textContent = '@'+(a.handle||a.name); }
$('#actorChip').addEventListener('click', e=>{ e.stopPropagation(); $('#acctMenu').classList.toggle('show'); });
$('#acctMenu').addEventListener('click', e=>e.stopPropagation());
document.addEventListener('click', ()=>$('#acctMenu').classList.remove('show'));
$('#logoutBtn').onclick=async()=>{
  if(!API.MOCK){ try{ await fetch('/logout',{method:'POST',credentials:'include'}); }catch(e){} }
  location.href = location.pathname;   // reload → login gate (live) / fresh (mock)
};

/* ================= canvas (selected node) ================= */
const cellEls={}; let phCols=[];
function buildBoard(){
  const wrap=$('#sections'); wrap.replaceChildren(); phCols=Array.from({length:STEPS},()=>[]);
  SECTIONS.forEach(sec=>{
    const div=document.createElement('div'); div.className='section sec-'+sec.id;
    const head=document.createElement('div'); head.className='secHead';
    const name=document.createElement('span'); name.className='secName'; name.textContent=sec.name;
    const hint=document.createElement('span'); hint.className='secHint'; hint.textContent=t('sec.'+sec.id);
    const clear=document.createElement('button'); clear.className='mini'; clear.dataset.clearsec=sec.id; clear.textContent='✕';
    head.append(name,hint,clear); div.appendChild(head);
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
    el.style.left=(n.x+panX)+'px'; el.style.top=(n.y+panY)+'px'; el.dataset.id=n.id;
    const cv=document.createElement('canvas'); drawThumb(cv, n.state); el.appendChild(cv);
    const nm=document.createElement('div'); nm.className='nname'; nm.textContent=dispName(n); if(!n.ghost) nm.title=t('node.renameHint'); el.appendChild(nm);
    if(n.ghost){
      const gb=document.createElement('div'); gb.className='ghostBtns';
      const accept=document.createElement('button'); accept.dataset.acc=n.id; accept.textContent='✓';
      const reject=document.createElement('button'); reject.dataset.rej=n.id; reject.textContent='✗';
      gb.append(accept,reject);
      el.appendChild(gb);
    } else {
      const meta=document.createElement('div'); meta.className='nmeta';
      const reps=document.createElement('button'); reps.dataset.reps=n.id; reps.textContent='×'+n.reps;
      const play=document.createElement('button'); play.dataset.play=n.id; play.textContent='▶';
      const start=document.createElement('button'); start.dataset.start=n.id; start.textContent='🏁';
      meta.append(reps,play,start);
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
  const ns='http://www.w3.org/2000/svg'; svg.replaceChildren();
  const defs=document.createElementNS(ns,'defs'); const marker=document.createElementNS(ns,'marker');
  marker.setAttribute('id','ah'); marker.setAttribute('markerWidth','8'); marker.setAttribute('markerHeight','8');
  marker.setAttribute('refX','7'); marker.setAttribute('refY','4'); marker.setAttribute('orient','auto');
  const arrow=document.createElementNS(ns,'path'); arrow.setAttribute('d','M0,0L8,4L0,8z'); arrow.setAttribute('fill','var(--cable)');
  marker.appendChild(arrow); defs.appendChild(marker); svg.appendChild(defs);
  graph.edges.forEach((e,i)=>{
    const a=[...gArea.querySelectorAll('.gnode')].find(el=>el.dataset.id===e.from);
    const b=[...gArea.querySelectorAll('.gnode')].find(el=>el.dataset.id===e.to);
    if(!a||!b) return;
    const ar=a.getBoundingClientRect(), br=b.getBoundingClientRect();
    const x1=ar.right-r.left, y1=ar.top-r.top+ar.height/2, x2=br.left-r.left, y2=br.top-r.top+br.height/2;
    const mx=(x1+x2)/2; const ghost=nodeById(e.to)?.ghost;
    const d=`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    const path=document.createElementNS(ns,'path'); path.setAttribute('d',d); path.setAttribute('fill','none');
    path.setAttribute('stroke',ghost?'rgba(224,159,62,.5)':'var(--cable)'); path.setAttribute('stroke-width','2.5');
    if(ghost) path.setAttribute('stroke-dasharray','5 4'); path.setAttribute('marker-end','url(#ah)'); svg.appendChild(path);
    const hit=document.createElementNS(ns,'path'); hit.setAttribute('class','hit'); hit.setAttribute('d',d);
    hit.setAttribute('fill','none'); hit.setAttribute('stroke','transparent'); hit.setAttribute('stroke-width','12');
    hit.dataset.edge=String(i); svg.appendChild(hit);
  });
}
function drawThumb(cv,pat){ const rows=SECTIONS.reduce((a,s)=>a+s.rows,0); cv.width=STEPS; cv.height=rows;
  const ctx=cv.getContext('2d'); ctx.fillStyle='#14120c'; ctx.fillRect(0,0,STEPS,rows);
  const colors={drums:'#ff5c47',k808:'#ff9e3d',keys:'#3fe8a0',bars:'#c990ff'}; let y=0;
  SECTIONS.forEach(sec=>{ ctx.fillStyle=colors[sec.id]; for(let r=0;r<sec.rows;r++) for(let c=0;c<STEPS;c++)
    if(pat.grids?.[sec.id]?.[r]?.[c]) ctx.fillRect(c,y+r,1,1); y+=sec.rows; }); }
function renderNodeThumb(id){ const el=gArea.querySelector(`.gnode[data-id="${id}"] canvas`); if(el) drawThumb(el, nodeById(id).state); }
function setActiveNode(id){ [...gArea.querySelectorAll('.gnode')].forEach(el=>el.classList.toggle('activeNode', el.dataset.id===id)); }

/* graph interactions: select, drag-move, edge-drag, controls */
let dragging=null, edgeDrag=null, panning=null;
let panX=0, panY=0;   // graph viewport offset (drag empty area to pan)
function applyPan(){ graph.nodes.forEach(n=>{ const el=gArea.querySelector(`.gnode[data-id="${n.id}"]`);
    if(el){ el.style.left=(n.x+panX)+'px'; el.style.top=(n.y+panY)+'px'; } }); renderEdges(); }
gArea.addEventListener('pointerdown',e=>{
  const port=e.target.closest('.port');
  if(port){ e.preventDefault(); edgeDrag={from:port.dataset.port}; return; }
  const node=e.target.closest('.gnode');
  if(!node){                                  // empty area → pan the canvas
    e.preventDefault(); panning={sx:e.clientX, sy:e.clientY, ox:panX, oy:panY}; gArea.style.cursor='grabbing'; return;
  }
  if(e.target.closest('button')||e.target.closest('.nx')) return;
  const n=nodeById(node.dataset.id);
  if(n.ghost){ selectNode(n.id); return; }
  selectNode(n.id);
  const r=gArea.getBoundingClientRect(); const ox=e.clientX-r.left-(n.x+panX), oy=e.clientY-r.top-(n.y+panY);
  dragging={id:n.id, ox, oy, moved:false};
});
window.addEventListener('pointermove',e=>{
  if(panning){ panX=panning.ox+(e.clientX-panning.sx); panY=panning.oy+(e.clientY-panning.sy); applyPan(); return; }
  if(dragging){ const n=nodeById(dragging.id); const r=gArea.getBoundingClientRect();
    n.x=e.clientX-r.left-dragging.ox-panX;
    n.y=e.clientY-r.top-dragging.oy-panY;
    dragging.moved=true;
    const el=gArea.querySelector(`.gnode[data-id="${n.id}"]`); if(el){ el.style.left=(n.x+panX)+'px'; el.style.top=(n.y+panY)+'px'; }
    renderEdges();
  }
});
window.addEventListener('pointerup',e=>{
  if(panning){ panning=null; gArea.style.cursor=''; }
  if(edgeDrag){ const node=document.elementFromPoint(e.clientX,e.clientY)?.closest('.gnode');
    if(node && node.dataset.id!==edgeDrag.from){ addEdge(edgeDrag.from, node.dataset.id); } edgeDrag=null; }
  if(dragging){ if(dragging.moved) op('move',{node:dispName(nodeById(dragging.id))}); dragging=null; }
});
gArea.addEventListener('dblclick',e=>{  // double-click a node's name to rename it inline
  const nm=e.target.closest('.nname'); if(!nm) return;
  const node=nm.closest('.gnode'); if(node){ e.stopPropagation(); renameNode(node.dataset.id, nm); } });
$('#nodeName').style.cursor='text'; $('#nodeName').title=t('node.renameHint');
$('#nodeName').addEventListener('dblclick', ()=>{ if(loop && selNode() && !selNode().ghost) renameNode(selId, $('#nodeName')); });
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
/* rename the whole track (loop title) — backend title PATCH (author only) */
/* in-page inline edit: swap an element for an <input>, commit on Enter/blur,
   cancel on Escape — no native prompt() dialogs */
function inlineEdit(el, current, opts, commit){
  if(el.dataset.editing) return;
  const ml=!!opts.multiline;
  const input=document.createElement(ml?'textarea':'input');
  input.className='inlineEdit '+(opts.cls||''); input.value=current; input.maxLength=opts.max||60;
  if(ml){ input.rows=1; input.spellcheck=false; }
  el.dataset.editing='1'; el.replaceWith(input); input.focus(); input.select();
  const grow=()=>{ if(ml){ input.style.height='auto'; input.style.height=input.scrollHeight+'px'; } };
  grow();
  let done=false;
  const finish=(save)=>{ if(done) return; done=true;
    const v=input.value.trim().replace(/\s+/g,' '); input.replaceWith(el); delete el.dataset.editing;
    if(save && v && v!==current) commit(v); };
  input.addEventListener('input', grow);
  input.addEventListener('keydown',e=>{ e.stopPropagation();
    if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); finish(true); }  // Enter commits; text wraps on its own
    else if(e.key==='Escape'){ e.preventDefault(); finish(false); } });
  input.addEventListener('blur',()=>finish(true));
}
/* rename the whole track (loop title) — inline edit → backend title PATCH */
function startLoopTitleEdit(){
  if(!loop) return;
  const loopId=loop.id;
  inlineEdit($('#songTitle'), loop.title||'', {max:120, cls:'big', multiline:true}, async(v)=>{
    try{ await enqueueMutation(async()=>{
        if(!loop || loop.id!==loopId) return;
        await persistDirtyCurrentLoop();
        const rec=await API.renameLoop(loop.id, v, loop.version);
        loop.title=(rec&&rec.title)||v; loop.version=rec.version;
        $('#songTitle').textContent=loop.title; refreshOps(); refreshFeed();
      }); }
    catch(e){ $('#songTitle').textContent=loop.title;
      if(/→ 403/.test(e.message)) toast(t('toast.notYours')); else toast(t('toast.saveFail',{err:e.message})); }
  });
}
$('#renameLoopBtn').onclick=startLoopTitleEdit;
$('#songTitle').addEventListener('dblclick', startLoopTitleEdit);

/* rename a section — sets a custom name (dispName prefers it), persists in graph */
function renameNode(id, el){
  const n=nodeById(id); if(!n || n.ghost) return;
  const cur=dispName(n);
  const target = el || $('#nodeName');
  inlineEdit(target, cur, {max:40}, (v)=>{
    n.custom=true; n.name=v;
    selectNode(selId,{silent:true}); renderGraph();
    op('rename',{node:v, from:cur});
  });
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

/* ================= variant generator (honest local tool — no agent role-play) =================
   "✨ Variants" branches the selected section into two ghost variant nodes you
   preview and keep/erase. It's a plain generator, not attributed to any agent —
   real agents show up only in the feed + op history via the real API. */
let ghost=null;   // pattern-ghost overlay retired; kept null for paint/playback checks
const VARIANTS=[{kind:'variation'},{kind:'lift'},{kind:'break'}];
function vSuffix(k){ return t('variant.'+(k==='break'?'brk':k)); }
$('#arrangeBtn').onclick=()=>{ if(!loop) return; const base=selNode(); if(!base||base.ghost){ toast(t('toast.pickSection')); return; }
  const defs=[...VARIANTS].sort(()=>rng()-.5).slice(0,2);
  defs.forEach((d,i)=>{ const v=addNode(mutate(base.state,d.kind),
      Math.min(base.x+170, gArea.clientWidth-140), Math.max(0,Math.min(gArea.clientHeight-70, base.y+(i?90:-90))),
      {ghost:true, reps:base.reps, k:'variant', vkind:d.kind, baseK:base.k, baseLetter:base.letter, baseName:base.name});
    graph.edges.push({from:base.id, to:v.id}); });
  renderGraph(); toast(t('toast.variantsAdded'));
  op('arrange',{node:dispName(base), variants:defs.map(d=>vSuffix(d.kind).trim())}); };
function mutate(s,kind){ const n=JSON.parse(JSON.stringify(s));
  if(kind==='lift'){ const k=n.grids.keys; for(let r=n.grids.keys.length-1;r>0;r--) k[r]=k[r-1].slice(); k[0]=Array(STEPS).fill(false);
    for(let s2=0;s2<16;s2++) if(s2%2===0) n.grids.drums[3][s2]=true; }
  else if(kind==='break'){ n.grids.drums=n.grids.drums.map((r,i)=>i===0?r.map((v,c)=>c%8===0&&v):Array(STEPS).fill(false));
    n.grids.keys=n.grids.keys.map(r=>r.map((v,c)=>v&&c<8)); }
  else { const k=n.grids.keys; for(let r=0;r<k.length;r++) for(let c=0;c<STEPS;c++) if(k[r][c]&&rng()<.5){ k[r][c]=false; const nr=Math.max(0,Math.min(7,r+pick([-1,1]))); k[nr][c]=true; }
    for(let c=1;c<16;c+=4) if(rng()<.6) n.grids.drums[3][c]=true; }
  return n; }
function acceptGhostNode(id){ const n=nodeById(id); if(!n) return; n.ghost=false; renderGraph(); op('add_node',{node:dispName(n)}); }
function rejectGhostNode(id){ const n=nodeById(id); graph.nodes=graph.nodes.filter(x=>x.id!==id);
  graph.edges=graph.edges.filter(e=>e.from!==id&&e.to!==id); renderGraph(); }

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
  const box=$('#opList'); box.replaceChildren();
  if(!shown.length){ const empty=document.createElement('div'); empty.className='empty'; empty.textContent=t('history.empty'); box.appendChild(empty); }
  shown.slice().reverse().forEach(o=>{ const L=opLine(o); const d=document.createElement('div'); d.className='opline '+L.kind;
    const who=document.createElement('span'); who.className='who'; who.textContent=L.who;
    const verb=document.createTextNode(' '+L.verb); const extra=document.createElement('span'); extra.className='ex'; extra.textContent=L.extra;
    d.append(who,verb,extra); box.appendChild(d); });
  $('#opCount').textContent=shown.length; }

/* ================= song lifecycle ================= */
async function newSong(){ try{
    await enqueueMutation(async()=>{
      await persistDirtyCurrentLoop();
      const rec=await API.createLoop({ title:nextTitle(), graph:freshGraph() });
      useLoop(rec); toast(t('toast.newSong',{title:rec.title})); refreshMyLoops();
    });
  }catch(e){ toast(t('toast.saveFail',{err:e.message})); } }

/* ================= loop browser (switch among your own works) ================= */
async function openLoopMenu(){
  const menu=$('#loopMenu'); menu.replaceChildren();
  let ls=[]; try{ ls=await API.listLoops(); }catch(e){}
  const mine=ls.filter(l=>l.authorId===RAP.actor.id)
    .sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
  mine.forEach(l=>{ const d=document.createElement('div');
    d.className='loopItem'+(loop && l.id===loop.id?' active':'');
    const nm=document.createElement('span'); nm.textContent=l.title||'—'; d.appendChild(nm);
    if(l.published){ const dot=document.createElement('span'); dot.className='dot'; dot.textContent='●'; d.appendChild(dot); }
    d.onclick=async()=>{ menu.classList.remove('show'); if(loop && l.id===loop.id) return;
      try{ await enqueueMutation(async()=>{
          await persistDirtyCurrentLoop();
          const full=await API.getLoop(l.id); useLoop(full);
        }); }catch(e){ toast(t('toast.saveFail',{err:e.message})); } };
    menu.appendChild(d); });
  if(!mine.length){ const e=document.createElement('div'); e.className='loopItem emptyItem'; e.textContent=t('browser.empty'); menu.appendChild(e); }
  const nw=document.createElement('div'); nw.className='loopItem newItem'; nw.textContent=t('browser.newLoop');
  nw.onclick=()=>{ menu.classList.remove('show'); newSong(); };
  menu.appendChild(nw); menu.classList.add('show');
}
function refreshMyLoops(){ if($('#loopMenu') && $('#loopMenu').classList.contains('show')) openLoopMenu(); }
$('#myLoopsBtn').addEventListener('click', e=>{ e.stopPropagation();
  const m=$('#loopMenu'); m.classList.contains('show')? m.classList.remove('show') : openLoopMenu(); });
$('#loopMenu').addEventListener('click', e=>e.stopPropagation());
document.addEventListener('click', ()=>$('#loopMenu').classList.remove('show'));
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
  const loopId=loop.id;
  try{ await enqueueMutation(async()=>{
      if(!loop || loop.id!==loopId) return;
      await persistDirtyCurrentLoop();
      const rec=await API.publish(loop.id, !loop.published, loop.version);
      loop.published=rec.published; loop.version=rec.version;
      $('#publishBtn').textContent=loop.published?t('board.published'):t('board.publish'); $('#publishBtn').classList.toggle('on',loop.published);
      toast(loop.published?t('toast.publishOk'):t('toast.unpublishOk')); refreshFeed(); refreshOps();
    }); }catch(e){ toast(t('toast.saveFail',{err:e.message})); } };
$('#forkBtn').onclick=async()=>{ if(!loop) return; await doFork(loop.id, loop.title); };
/* strip stacked flip/fork suffixes so repeated 接力 doesn't pile up
   "X · flip · flip · flip"; a fork keeps the source's base name */
function baseTitle(title){
  // strip a trailing flip/fork token (any separator char) repeatedly
  const re=/[\s·•・|\-–]*(?:flip|Flip|接力版|\(fork\))\s*$/;
  let s=(title||'').trim(), prev;
  do{ prev=s; s=s.replace(re,'').trim(); }while(s && s!==prev);
  return s||title||'Untitled';
}
async function doFork(id, title){ try{
    await enqueueMutation(async()=>{
      await persistDirtyCurrentLoop();
      const rec=await API.fork(id, baseTitle(title));
      rec._forkedTitle=baseTitle(title); useLoop(rec); toast(t('toast.flipOk'));
      refreshFeed(); refreshMyLoops(); window.scrollTo({top:0,behavior:'smooth'});
    });
  }catch(e){ toast(t('toast.saveFail',{err:e.message})); } }
$('#wavBtn').onclick=async()=>{ if(!loop) return; ensureAudio(); toast(t('toast.renderWav'));
  const buf=await renderState(st,2); const a=document.createElement('a'); a.href=URL.createObjectURL(bufToWav(buf)); a.download=(dispName(selNode())||'loop')+'.wav'; a.click(); };
$('#songWavBtn').onclick=async()=>{ if(!loop) return; ensureAudio(); const seq=buildSong(); if(!seq.length){ toast(t('toast.noSections')); return; }
  toast(t('toast.renderSong')); const buf=await renderSong(seq); const a=document.createElement('a'); a.href=URL.createObjectURL(bufToWav(buf)); a.download=(loop.title||'song')+'.wav'; a.click(); };

/* ================= Jam Feed ================= */
let feedAudio=null, feedPlayingId=null;
async function refreshFeed(){ let ls=[]; try{ ls=await API.listLoops({published:true}); }catch(e){}
  const wrap=$('#cards'); wrap.replaceChildren();
  if(!ls.length){ const empty=document.createElement('div'); empty.className='empty'; empty.textContent=t('feed.empty'); wrap.appendChild(empty); return; }
  ls.forEach(item=>{ const g=normalizeGraph(item.graph); const start=g.nodes.find(n=>n.id===g.startId)||g.nodes[0];
    const card=document.createElement('div'); card.className='card';
    const cv=document.createElement('canvas'); drawThumb(cv, start.state); card.appendChild(cv);
    const titleEl=document.createElement('div'); titleEl.className='t'; titleEl.textContent=item.title; card.appendChild(titleEl);
    const meta=document.createElement('div'); meta.className='meta';
    meta.appendChild(document.createTextNode(`${start.state.bpm||88} BPM · ${(item.authorKind==='agent'?'🤖':'🧑')} ${item.authorName||item.authorId}`));
    if(item.forkedFrom){ meta.appendChild(document.createTextNode(' · ')); const from=document.createElement('span'); from.className='from'; from.textContent=t('feed.flipped'); meta.appendChild(from); }
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
   Guardrails: solid kick/snare backbone, steady hats, and a real 4-bar
   chord progression (from SCALES[mood].chords) that drives BOTH layers:
   the 808 plays a chord tone locked to the kick rhythm, the keys restate
   a 1-bar motif on each bar's chord tones. Everything stays pentatonic. */
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

  // --- harmony: one real 4-bar progression drives 808 + keys ---
  const chords=SCALES[s.mood].chords, pent=SCALES[s.mood].pent;
  const prog=pick([[0,2,3,1],[0,3,1,2],[0,0,2,3],[0,1,2,3],[1,2,0,3]]);
  const pcOf=(sec,row)=>{ const fb=sec.rows-1-row;
    return (((sec.base+Math.floor(fb/5)*12+pent[fb%5])%12)+12)%12; };
  const rowForPc=(sec,pcs,prefer)=>{ let best=null,bestD=99;
    for(let r=0;r<sec.rows;r++){ if(!pcs.includes(pcOf(sec,r))) continue;
      const d=Math.abs(r-prefer); if(d<bestD){bestD=d;best=r;} }
    return best; };
  const k808sec=secById('k808'), keyssec=secById('keys');
  const kickSteps=[]; G.drums[0].forEach((v,x)=>{ if(v) kickSteps.push(x); });

  // 808: a chord tone (root preferred) on every kick hit of that bar —
  // bass locking to the kick is what makes it sound played, not scattered.
  prog.forEach((ci,bar)=>{
    const pcs=chords[ci].notes.map(n=>((n%12)+12)%12);
    let row=rowForPc(k808sec,[pcs[0]],5) ?? rowForPc(k808sec,pcs.slice(1),5) ?? 5;
    const hits=kickSteps.filter(x=>Math.floor(x/4)===bar);
    (hits.length?hits:[bar*4]).forEach(x=>G.k808[row][x]=true);
    if(bar===3&&rng()<.5) G.k808[cl(row-1,0,5)][15]=true;   // approach note into the loop
  });

  // keys: one rhythmic motif restated on each bar's chord tones, with a
  // breath in bar 3 and a resolve in bar 4 — repetition is what reads as
  // "written" instead of "dice".
  const rhythm=pick([[0,2],[0,3],[0,2,3],[1,3],[0,1,3]]);
  prog.forEach((ci,bar)=>{
    const pcs=chords[ci].notes.map(n=>((n%12)+12)%12);
    const anchor=rowForPc(keyssec,pcs,4) ?? pick([3,4]);
    rhythm.forEach((off,i)=>{
      if(bar===2&&i===rhythm.length-1&&rng()<.6) return;      // breathe
      if(bar===3&&i>0&&off===rhythm[rhythm.length-1]) return;  // resolve: drop trailing hit
      G.keys[cl(anchor+(i?pick([-1,0,1]):0),0,7)][bar*4+off]=true;
    });
  });
  return s; }

/* ================= identity (Login-with-Raft) ================= */
/* token expired mid-session → show a clear re-login bar instead of failing silently */
window.onAuthExpired = function(){ const b=document.getElementById('sessionBar'); if(b) b.classList.add('show'); };
async function resolveIdentity(){ if(API.MOCK) return true;
  const params=new URLSearchParams(location.search);
  const devMode=!!(params.get('dev'));
  try{ const me=await API.me();
    RAP.actor={ id:me.id||me.sub||me.actorId, kind:(me.kind||me.type)==='agent'?'agent':'human',
      name:me.name||me.displayName||me.id||me.sub, handle:me.handle||me.username||me.name||me.sub };
    renderActor(); return true;
  }catch(e){ if(/→ 401/.test(e.message)&&!devMode) showLogin(); else showUnavailable(); return false; } }
function showLogin(){ const m=document.querySelector('main'); m.style.display='block';
  const gate=document.createElement('div'); gate.className='loginGate';
  const logo=document.createElement('div'); logo.className='logo loginLogo'; logo.appendChild(document.createTextNode('musik'));
  const bold=document.createElement('b'); bold.textContent='.build'; logo.appendChild(bold);
  const blurb=document.createElement('div'); blurb.className='loginBlurb'; blurb.textContent=t('login.blurb');
  const link=document.createElement('a'); link.href='/login'; const button=document.createElement('button');
  button.className='primary loginButton'; button.textContent=t('login.cta'); link.appendChild(button);
  gate.append(logo,blurb,link); m.replaceChildren(gate); }
function showUnavailable(){ const m=document.querySelector('main'); m.style.display='block';
  const gate=document.createElement('div'); gate.className='loginGate';
  const blurb=document.createElement('div'); blurb.className='loginBlurb'; blurb.textContent=t('login.unavailable');
  const button=document.createElement('button'); button.className='primary loginButton';
  button.textContent=t('login.retry'); button.addEventListener('click',()=>location.reload());
  gate.append(blurb,button); m.replaceChildren(gate); }

/* ================= boot ================= */
/* re-render dynamic (t()-driven) content on language switch */
window.onLangChange = function(){
  renderActor();
  if(!loop) return;   // login gate: static data-i18n already re-applied
  $('#publishBtn').textContent = loop.published? t('board.published') : t('board.publish');
  selectNode(selId, {silent:true});   // node name + board in new language
  renderGraph(); refreshOps(); refreshFeed();
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
}
async function seedIfEmpty(){ const ls=await API.listLoops(); if(ls.length) return;
  const prev=RAP.actor;
  setActor({id:'agent:ed',kind:'agent',name:'@Ed'});
  const g=freshGraph(); g.nodes.push({id:'n2',k:'chorus',x:250,y:30,reps:2,state:mutate(g.nodes[0].state,'lift')});
  g.edges.push({from:'n1',to:'n2'}); g.edges.push({from:'n2',to:'n1'}); g.counter=2;
  const a=await API.createLoop({title:'Concrete Bars', graph:g}); await API.publish(a.id,true,a.version);
  setActor({id:'human:alice',kind:'human',name:'Alice'});
  const b=await API.fork(a.id,'Concrete Bars'); const bg=normalizeGraph(b.graph); bg.nodes[0].state.bpm=96;
  const updated=await API.patchLoop(b.id,'set_tempo',{node:t('node.verse',{},'en')||'A',bpm:96},b.graph,b.version); await API.publish(b.id,true,updated.version);
  setActor(prev);
}
boot();
