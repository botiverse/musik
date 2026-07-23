/* ============================================================
   musik.build — API layer
   One interface, two backends:
   - REAL  : talks to the Cloudflare Worker at /api/*
   - MOCK  : localStorage, so the app runs standalone over file://
   The UI never knows which is active. Swap = set a base URL.
   ============================================================ */
"use strict";

const RAP = {}; // shared namespace across the app's classic scripts

/* ---- actor identity ----
   REAL mode: injected by the page from the Login-with-Raft session
   (human) or from the agent token (agent). MOCK mode: switchable in UI
   so you can SEE human vs agent ops land in the same audit log. */
RAP.actor = { id: 'local:you', kind: 'human', name: 'You' };
function setActor(a){ RAP.actor = a; localStorage.setItem('rap.actor', JSON.stringify(a)); }

/* REAL-mode auth: identity is proven by the app's opaque HttpOnly session or
   a Raft bearer token supplied by a non-browser API client.
   Dev bridge: backend DEV_AUTH=1 accepts X-Dev-Actor: "<kind>:<name>". */
RAP.devActor = null;                     // e.g. "human:alice" / "agent:ed" during local联调

/* action vocabulary — shared with backend audit log */
const ACTIONS = {
  create_loop:'建了 loop', fork:'fork 了', publish:'发布了', unpublish:'撤下了',
  update_node:'改了段落', add_node:'加了段落', remove_node:'删了段落',
  add_edge:'连了线', remove_edge:'断了线', set_start:'设了起点',
  set_tempo:'调了速度', add_bar:'写了词', clear:'清了画布', rename:'改了名'
};

/* Detect backend: if we're served over http(s), assume /api is live.
   Over file:// there is no server → mock. Overridable via ?api= or window. */
const API = (function(){
  const qs = new URLSearchParams(location.search);
  let base = qs.get('api');
  if(base===null){
    base = (location.protocol==='http:'||location.protocol==='https:') ? '/api' : null;
  }
  const MOCK = !base;
  if(MOCK){
    try{ const saved=JSON.parse(localStorage.getItem('rap.actor')||'null'); if(saved) RAP.actor=saved; }catch(e){}
  }

  /* ---------------- REAL ---------------- */
  async function req(method, path, body){
    const headers = { 'Content-Type':'application/json' };
    // dev bridge: pick up ?dev=agent:ed or window-set devActor when no real token
    const dev = RAP.devActor || new URLSearchParams(location.search).get('dev');
    if(dev) headers['X-Dev-Actor'] = dev;
    const r = await fetch(base+path, {
      method, headers, credentials:'include',
      body: body!=null ? JSON.stringify(body) : undefined
    });
    if(r.status===401 && window.onAuthExpired) window.onAuthExpired();   // session dropped — surface it, don't fall silent
    if(!r.ok){
      let detail=null; try{ detail=await r.json(); }catch(e){}
      const error=new Error('API '+method+' '+path+' → '+r.status);
      error.status=r.status; error.code=detail&&detail.code; throw error;
    }
    return r.status===204 ? null : r.json();
  }

  /* ---------------- MOCK ---------------- */
  const KEY='rap.db.v1';
  function db(){ try{ return JSON.parse(localStorage.getItem(KEY)) || {loops:{},ops:{},order:[]}; }
    catch(e){ return {loops:{},ops:{},order:[]}; } }
  function save(d){ localStorage.setItem(KEY, JSON.stringify(d)); }
  let seq = 0;
  function uid(p){ seq++; return p+Date.now().toString(36)+seq.toString(36); }
  function now(){ return Date.now(); }
  function logOp(d, loopId, action, payload){
    (d.ops[loopId] = d.ops[loopId]||[]).push({
      id:uid('op'), loopId, actorId:RAP.actor.id, actorKind:RAP.actor.kind,
      actorName:RAP.actor.name, action, payload:payload||null, ts:now()
    });
  }
  const mock = {
    async listLoops(opts={}){
      const d=db();
      let ls=d.order.map(id=>d.loops[id]).filter(Boolean);
      if(opts.published) ls=ls.filter(l=>l.published);
      return ls.map(stripGraphForList).reverse();
    },
    async getLoop(id){ const d=db(); const l=d.loops[id]; if(!l) throw new Error('loop 404'); return l; },
    async createLoop(loop){
      const d=db(); const id=uid('loop');
      const rec={ id, title:loop.title||'Untitled', authorId:RAP.actor.id, authorKind:RAP.actor.kind,
        authorName:RAP.actor.name, createdAt:now(), updatedAt:now(), published:false,
        forkedFrom:loop.forkedFrom||null, forkRoot:loop.forkRoot||null,
        graph:loop.graph, version:1 };
      if(!rec.forkRoot) rec.forkRoot=id;
      d.loops[id]=rec; d.order.push(id);
      logOp(d,id,'create_loop',{title:rec.title, forkedFrom:rec.forkedFrom});
      save(d); return rec;
    },
    async patchLoop(id, action, payload, graph, version){
      const d=db(); const l=d.loops[id]; if(!l) throw new Error('loop 404');
      if(version!==undefined && version!==l.version) throw new Error('loop 409');
      if(graph!==undefined) l.graph=graph;
      l.updatedAt=now(); l.version=(l.version||1)+1;
      logOp(d,id,action,payload);
      save(d); return l;
    },
    async publish(id, published=true, version){
      const d=db(); const l=d.loops[id]; if(!l) throw new Error('loop 404');
      if(version!==undefined && version!==l.version) throw new Error('loop 409');
      l.published=published; l.updatedAt=now(); l.version=(l.version||1)+1;
      logOp(d,id,published?'publish':'unpublish',{title:l.title});
      save(d); return l;
    },
    async renameLoop(id, title, version){
      const d=db(); const l=d.loops[id]; if(!l) throw new Error('loop 404');
      if(version!==undefined && version!==l.version) throw new Error('loop 409');
      l.title=title; l.updatedAt=now(); l.version=(l.version||1)+1;
      logOp(d,id,'rename',{title});
      save(d); return l;
    },
    async fork(id, title){
      const d=db(); const src=d.loops[id]; if(!src) throw new Error('loop 404');
      const nid=uid('loop');
      const rec={ id:nid, title:title||(src.title+' (fork)'), authorId:RAP.actor.id, authorKind:RAP.actor.kind,
        authorName:RAP.actor.name, createdAt:now(), updatedAt:now(), published:false,
        forkedFrom:src.id, forkRoot:src.forkRoot||src.id, graph:JSON.parse(JSON.stringify(src.graph)), version:1 };
      d.loops[nid]=rec; d.order.push(nid);
      // fork op recorded on the child (matches backend: child-side lineage)
      logOp(d,nid,'fork',{from:src.id, fromTitle:src.title, fromAuthor:src.authorName});
      save(d); return rec;
    },
    async getOps(id){ const d=db(); return (d.ops[id]||[]).slice(); },
    async recentOps(limit=40){
      const d=db(); const all=[];
      for(const k in d.ops) for(const o of d.ops[k]) all.push(o);
      all.sort((a,b)=>b.ts-a.ts); return all.slice(0,limit);
    },
    async me(){ return { id:RAP.actor.id, kind:RAP.actor.kind, name:RAP.actor.name }; }
  };

  /* ---------------- REAL wrappers (same signatures) ---------------- */
  const real = {
    listLoops:(opts={})=>req('GET','/loops?limit=50'+(opts.published?'&published=1':'')).then(p=>p.items),
    getLoop:(id)=>req('GET','/loops/'+id),
    createLoop:(loop)=>req('POST','/loops',loop),
    patchLoop:(id,action,payload,graph,version)=>req('PATCH','/loops/'+id,{graph,version,op:{action,payload}}),
    publish:(id,published=true,version)=>req('POST','/loops/'+id+'/publish',{published,version}),
    renameLoop:(id,title,version)=>req('PATCH','/loops/'+id,{title,version}),
    fork:(id,title)=>req('POST','/loops/'+id+'/fork',{title}),
    getOps:(id)=>req('GET','/loops/'+id+'/ops?limit=50').then(p=>p.items),
    // optional global activity ticker; degrades to empty if backend lacks it
    recentOps:(limit=40)=>req('GET','/ops?limit='+Math.min(limit,50)).then(p=>p.items).catch(()=>[]),
    me:()=>req('GET','/me')
  };

  function stripGraphForList(l){
    return { id:l.id, title:l.title, authorId:l.authorId, authorName:l.authorName, authorKind:l.authorKind,
      createdAt:l.createdAt, updatedAt:l.updatedAt, published:l.published,
      forkedFrom:l.forkedFrom, forkRoot:l.forkRoot, graph:l.graph, version:l.version||1 };
  }

  const impl = MOCK ? mock : real;
  impl.MOCK = MOCK;
  impl.base = base;
  return impl;
})();
