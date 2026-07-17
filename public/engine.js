/* ============================================================
   musik.build — rap / hip-hop audio engine (Web Audio, offline-capable)
   Sections: DRUMS (kick/snare/clap/hat/openhat), 808 (pitched sub),
             KEYS (melody/chords), BARS (syllable vox blips + rhyme flow)
   Same scheduleStep() serves live playback and offline WAV render.
   ============================================================ */
"use strict";

const STEPS = 16;

/* deterministic RNG (Date.now/Math.random unavailable in some sandboxes; ok here) */
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);
  t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
let rng = mulberry32(0x9E3779B9);
const pick = arr => arr[Math.floor(rng()*arr.length)];

/* pentatonic scales — kept minor-leaning for hip-hop feel */
const SCALES = {
  dark:{pent:[0,3,5,7,10], chords:[
    {label:'Cm', notes:[48,55,58,63]},
    {label:'A♭', notes:[44,51,56,60]},
    {label:'E♭', notes:[51,58,62,67]},
    {label:'G',  notes:[43,50,58,62]}]},
  bright:{pent:[0,2,4,7,9], chords:[
    {label:'C',  notes:[48,55,59,64]},
    {label:'Am', notes:[45,52,57,60]},
    {label:'F',  notes:[53,57,60,65]},
    {label:'G',  notes:[43,50,59,62]}]}
};
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const nName = m => NOTE_NAMES[((m%12)+12)%12] + (Math.floor(m/12)-1);
const mtof = m => 440*Math.pow(2,(m-69)/12);

/* Section model. 808 is pitched (chromatic-ish via pentatonic rows). */
/* section hints are rendered via i18n t('sec.<id>') in the UI, not from here */
const SECTIONS = [
  {id:'drums', name:'DRUMS', rows:5, type:'drum', labels:['Kick','Snare','Clap','Hat','Open']},
  {id:'k808',  name:'808',   rows:6, type:'pitch', base:31},
  {id:'keys',  name:'KEYS',  rows:8, type:'pitch', base:60},
  {id:'bars',  name:'BARS',  rows:1, type:'bars'}
];
function secById(id){ return SECTIONS.find(s=>s.id===id); }

function emptyGrids(){
  const g={};
  SECTIONS.forEach(s=> g[s.id] = Array.from({length:s.rows},()=>Array(STEPS).fill(false)));
  return g;
}
function cloneGrids(g){ const o={}; for(const k in g){ o[k]=g[k].map(r=>r.slice()); } return o; }

/* a "state" = one loop cell's musical content */
function emptyState(){
  return { grids:emptyGrids(), bpm:88, swing:0.14, mood:'dark', bars:{} };
  // bars: { "<step>": "word" } typed lyrics keyed by step index
}

/* row → midi note (row 0 = highest) */
function rowToNote(sec, row){
  const pent = SCALES[curMood].pent;
  const fromBottom = sec.rows-1-row;
  return sec.base + Math.floor(fromBottom/5)*12 + pent[fromBottom%5];
}
let curMood = 'dark'; // engine reads the active state's mood at schedule time

/* ============ audio rig ============ */
function makeRig(ctx){
  const master=ctx.createGain(); master.gain.value=.72;
  const comp=ctx.createDynamicsCompressor();
  comp.threshold.value=-16; comp.ratio.value=4; comp.knee.value=22; comp.attack.value=.003; comp.release.value=.18;
  master.connect(comp); comp.connect(ctx.destination);
  const verb=ctx.createConvolver(); verb.buffer=impulse(ctx,1.8,2.6);
  const verbGain=ctx.createGain(); verbGain.gain.value=.32; verb.connect(verbGain); verbGain.connect(master);
  const dly=ctx.createDelay(1); dly.delayTime.value=.26;
  const fb=ctx.createGain(); fb.gain.value=.28; const dOut=ctx.createGain(); dOut.gain.value=.2;
  dly.connect(fb); fb.connect(dly); dly.connect(dOut); dOut.connect(master);
  const noise=noiseBuf(ctx);
  return {ctx,master,verb,dly,noise};
}
function impulse(ctx,dur,decay){ const len=ctx.sampleRate*dur, b=ctx.createBuffer(2,len,ctx.sampleRate);
  for(let c=0;c<2;c++){const d=b.getChannelData(c); for(let i=0;i<len;i++) d[i]=(mrand()*2-1)*Math.pow(1-i/len,decay);}
  return b; }
function noiseBuf(ctx){ const b=ctx.createBuffer(1,ctx.sampleRate*2,ctx.sampleRate); const d=b.getChannelData(0);
  for(let i=0;i<d.length;i++) d[i]=mrand()*2-1; return b; }
/* small local prng for buffer fill (avoids Math.random ban being an issue) */
let _s=12345; function mrand(){ _s=(_s*1103515245+12345)&0x7fffffff; return _s/0x7fffffff; }
function noiseSrc(r,t,dur){ const s=r.ctx.createBufferSource(); s.buffer=r.noise; s.loop=true; s.start(t); s.stop(t+dur+.1); return s; }
function envHit(g,t,a,peak,d){ g.gain.setValueAtTime(.0001,t); g.gain.linearRampToValueAtTime(peak,t+a);
  g.gain.exponentialRampToValueAtTime(.0001,t+a+d); }

/* ---- drums ---- */
function kick(r,t,v=1){ const o=r.ctx.createOscillator(),g=r.ctx.createGain();
  o.frequency.setValueAtTime(160,t); o.frequency.exponentialRampToValueAtTime(45,t+.13);
  envHit(g,t,.002,1.0*v,.34); o.connect(g); g.connect(r.master); o.start(t); o.stop(t+.42); }
function snare(r,t,v=1){ const n=noiseSrc(r,t,.22),bp=r.ctx.createBiquadFilter(),g=r.ctx.createGain();
  bp.type='bandpass'; bp.frequency.value=1900; bp.Q.value=.7; envHit(g,t,.001,.5*v,.16);
  n.connect(bp); bp.connect(g); g.connect(r.master);
  const o=r.ctx.createOscillator(),g2=r.ctx.createGain(); o.type='triangle';
  o.frequency.setValueAtTime(200,t); o.frequency.exponentialRampToValueAtTime(120,t+.07);
  envHit(g2,t,.001,.32*v,.08); o.connect(g2); g2.connect(r.master); o.start(t); o.stop(t+.14);
  const vs=r.ctx.createGain(); vs.gain.value=.2; g.connect(vs); vs.connect(r.verb); }
function clap(r,t,v=1){ // 3 quick noise bursts = clap
  [0,.011,.022].forEach((off,i)=>{ const n=noiseSrc(r,t+off,.12),bp=r.ctx.createBiquadFilter(),g=r.ctx.createGain();
    bp.type='bandpass'; bp.frequency.value=1500; bp.Q.value=.9; envHit(g,t+off,.001,(i===2?.42:.26)*v,i===2?.14:.05);
    n.connect(bp); bp.connect(g); g.connect(r.master);
    const vs=r.ctx.createGain(); vs.gain.value=.25; g.connect(vs); vs.connect(r.verb); }); }
function hat(r,t,v=1,open=false){ const n=noiseSrc(r,t,open?.35:.06),hp=r.ctx.createBiquadFilter(),g=r.ctx.createGain();
  hp.type='highpass'; hp.frequency.value=8000; envHit(g,t,.001,(open?.26:.22)*v,open?.3:.035);
  n.connect(hp); hp.connect(g); g.connect(r.master); }

/* ---- 808: sine sub with pitch glide into the note + soft distortion ---- */
function k808(r,t,note,dur,glideFrom){ const o=r.ctx.createOscillator(); o.type='sine';
  const f=mtof(note);
  if(glideFrom!=null){ o.frequency.setValueAtTime(mtof(glideFrom),t); o.frequency.exponentialRampToValueAtTime(f,t+Math.min(.09,dur*.5)); }
  else o.frequency.setValueAtTime(f,t);
  const sh=r.ctx.createWaveShaper(); sh.curve=softCurve(); // grit
  const g=r.ctx.createGain();
  const a=.004, rel=Math.min(.14,dur*.4);
  g.gain.setValueAtTime(.0001,t); g.gain.linearRampToValueAtTime(.85,t+a);
  g.gain.setValueAtTime(.85,t+Math.max(a,dur-rel)); g.gain.exponentialRampToValueAtTime(.0001,t+dur+.02);
  o.connect(sh); sh.connect(g); g.connect(r.master); o.start(t); o.stop(t+dur+.06); }
let _curve=null; function softCurve(){ if(_curve) return _curve; const n=1024,c=new Float32Array(n);
  for(let i=0;i<n;i++){ const x=i/n*2-1; c[i]=Math.tanh(x*1.8); } return _curve=c; }

/* ---- keys: soft pluck ---- */
function keys(r,t,note,v=1){ const o=r.ctx.createOscillator(); o.type='triangle'; o.frequency.value=mtof(note);
  const o2=r.ctx.createOscillator(); o2.type='sine'; o2.frequency.value=mtof(note+12);
  const lp=r.ctx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=3200;
  const g=r.ctx.createGain(),g2=r.ctx.createGain(); envHit(g,t,.004,.26*v,.42); envHit(g2,t,.004,.06*v,.3);
  o.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g); g.connect(r.master);
  const ds=r.ctx.createGain(); ds.gain.value=.35; g.connect(ds); ds.connect(r.dly);
  o.start(t); o.stop(t+.6); o2.start(t); o2.stop(t+.6); }

/* ---- bars: short vocal-ish blip so the flow is audible ---- */
function vox(r,t,accent){ const o=r.ctx.createOscillator(); o.type='sawtooth';
  o.frequency.setValueAtTime(accent?150:120,t); o.frequency.linearRampToValueAtTime(accent?200:150,t+.05);
  const bp=r.ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=accent?900:700; bp.Q.value=4;
  const g=r.ctx.createGain(); envHit(g,t,.006,accent?.2:.13,.11);
  o.connect(bp); bp.connect(g); g.connect(r.master); o.start(t); o.stop(t+.16); }

/* continuous-run length for pitched glide notes (808 / keys held) */
function runLen(row,s){ if(row.every(v=>v)) return s===0?STEPS:0;
  if(row[(s-1+STEPS)%STEPS]) return 0; let n=1; while(n<STEPS && row[(s+n)%STEPS]) n++; return n; }

/* schedule one 16th step of `st` at audio time t */
function scheduleStep(r, st, s, t, stepDur, ghost){
  curMood = st.mood; const G=st.grids;
  const hit=(id,fn)=>{ const sec=secById(id);
    for(let row=0;row<sec.rows;row++){ if(G[id][row][s]) fn(row,1,G[id][row]);
      if(ghost && ghost.section===id && ghost.grid[row][s]) fn(row,.6,ghost.grid[row]); } };
  hit('drums',(row,v)=>{ if(row===0)kick(r,t,v); else if(row===1)snare(r,t,v);
    else if(row===2)clap(r,t,v); else if(row===3)hat(r,t,v,false); else hat(r,t,v,true); });
  hit('k808',(row,v,full)=>{ const len=runLen(full,s); if(!len) return;
    const note=rowToNote(secById('k808'),row);
    // glide up/down from an 808 note that ended on the previous step (classic 808 slide)
    let from=null;
    for(let r2=0;r2<6;r2++){ if(r2!==row && G.k808[r2][(s-1+STEPS)%STEPS]){ from=rowToNote(secById('k808'),r2); break; } }
    k808(r,t,note,len*stepDur*.98,from); });
  hit('keys',(row,v)=>keys(r,t,rowToNote(secById('keys'),row),v));
  hit('bars',(row,v)=>{ const accent=(s%4===0); vox(r,t,accent); });
}

/* ---- offline render (feed preview / WAV) ---- */
async function renderState(st, loops=2){
  const sd=60/st.bpm/4, dur=sd*STEPS*loops+1.4;
  const ctx=new OfflineAudioContext(2, Math.ceil(44100*dur), 44100);
  const r=makeRig(ctx);
  for(let l=0;l<loops;l++) for(let s=0;s<STEPS;s++){
    const t=.05+(l*STEPS+s)*sd+((s%2===1)?st.swing*sd*.55:0);
    scheduleStep(r,st,s,t,sd,null);
  }
  return ctx.startRendering();
}
/* render a whole song = sequence of states back to back */
async function renderSong(states){
  if(!states.length) return null;
  const sd0=60/states[0].bpm/4;
  let total=1.4; states.forEach(st=>{ total += (60/st.bpm/4)*STEPS*st.reps; });
  const ctx=new OfflineAudioContext(2, Math.ceil(44100*total), 44100);
  const r=makeRig(ctx); let t=.05;
  states.forEach(st=>{ const sd=60/st.bpm/4;
    for(let l=0;l<st.reps;l++) for(let s=0;s<STEPS;s++){
      scheduleStep(r,st,s,t+((s%2===1)?st.swing*sd*.55:0),sd,null); t+=sd; }
  });
  return ctx.startRendering();
}

function bufToWav(buf){ const n=buf.length,ch=2,len=44+n*ch*2,ab=new ArrayBuffer(len),v=new DataView(ab);
  const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i))};
  ws(0,'RIFF'); v.setUint32(4,len-8,true); ws(8,'WAVEfmt '); v.setUint32(16,16,true);
  v.setUint16(20,1,true); v.setUint16(22,ch,true); v.setUint32(24,44100,true);
  v.setUint32(28,44100*ch*2,true); v.setUint16(32,ch*2,true); v.setUint16(34,16,true);
  ws(36,'data'); v.setUint32(40,n*ch*2,true);
  const L=buf.getChannelData(0),R=buf.getChannelData(1); let o=44;
  for(let i=0;i<n;i++){ v.setInt16(o,Math.max(-1,Math.min(1,L[i]))*32767,true); o+=2;
    v.setInt16(o,Math.max(-1,Math.min(1,R[i]))*32767,true); o+=2; }
  return new Blob([ab],{type:'audio/wav'}); }
