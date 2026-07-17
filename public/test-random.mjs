// Bun harness: evaluate the REAL randomState() from public/app.js with the
// REAL tables from public/engine.js, and assert listenability invariants.
// Usage: bun test-random.mjs
import { readFileSync } from 'fs';

const engine = readFileSync(new URL('./engine.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

// extract the randomState function verbatim from app.js
const start = app.indexOf('function randomState(){');
if (start < 0) throw new Error('randomState not found');
const endMarker = 'return s; }';
const end = app.indexOf(endMarker, start);
if (end < 0) throw new Error('randomState end not found');
const randomStateSrc = app.slice(start, end + endMarker.length);

const harness = `
;(function runTests(){
  const R=[]; for(let i=0;i<400;i++) R.push(randomState());
  const issues=[];
  const pcOf=(sec,row,pent)=>{ const fb=sec.rows-1-row;
    return (((sec.base+Math.floor(fb/5)*12+pent[fb%5])%12)+12)%12; };
  const k808=secById('k808'), keys=secById('keys');
  let keysCounts=[], strongChordTone=0, strongTotal=0, bassLocked=0, bassTotal=0;
  R.forEach((s,idx)=>{
    const G=s.grids, pent=SCALES[s.mood].pent, chords=SCALES[s.mood].chords;
    if(!G.drums[0][0]) issues.push(idx+': no downbeat kick');
    if(!G.drums[1][4]||!G.drums[1][12]) issues.push(idx+': no backbeat snare');
    let kc=0;
    for(let bar=0;bar<4;bar++){
      const b808=[], bKeys=[], kicks=[];
      for(let x=bar*4;x<bar*4+4;x++){
        if(G.drums[0][x]) kicks.push(x);
        for(let r=0;r<k808.rows;r++) if(G.k808[r][x]) b808.push({x,pc:pcOf(k808,r,pent)});
        for(let r=0;r<keys.rows;r++) if(G.keys[r][x]){ bKeys.push({x,pc:pcOf(keys,r,pent)}); kc++; }
      }
      if(!b808.length) issues.push(idx+': bar'+bar+' no 808');
      // every bar must fit ONE common chord for: all 808 (excluding a
      // step-15 approach note) and the FIRST keys hit; later keys hits are
      // pentatonic passing tones by design (±1 row), not checked here.
      const ok=chords.some(c=>{ const pcs=c.notes.map(n=>((n%12)+12)%12);
        return b808.filter(n=>n.x%4!==3).every(n=>pcs.includes(n.pc))
            && (!bKeys.length || pcs.includes(bKeys[0].pc)); });
      if(!ok) issues.push(idx+': bar'+bar+' off-chord 808='+JSON.stringify(b808)+' keys='+JSON.stringify(bKeys));
      // first keys hit of the bar is a chord tone of that same chord
      if(bKeys.length){
        strongTotal++;
        const okStrong=chords.some(c=>{ const pcs=c.notes.map(n=>((n%12)+12)%12);
          return pcs.includes(bKeys[0].pc); });
        if(okStrong) strongChordTone++;
      }
      // 808 onsets ⊂ (kick onsets ∪ bar start ∪ step15 approach)
      b808.forEach(n=>{ bassTotal++;
        if(kicks.includes(n.x) || n.x===bar*4 || n.x%4===3) bassLocked++; });
    }
    if(kc<3||kc>12) issues.push(idx+': keys density '+kc);
    keysCounts.push(kc);
  });
  const uniq=new Set(R.map(s=>JSON.stringify(s.grids))).size;
  return JSON.stringify({
    rolls:R.length, uniq,
    issueCount:issues.length, issues:issues.slice(0,8),
    strongChordTonePct:Math.round(100*strongChordTone/strongTotal),
    bassLockPct:Math.round(100*bassLocked/bassTotal),
    avgKeys:(keysCounts.reduce((a,b)=>a+b,0)/keysCounts.length).toFixed(1),
  },null,1);
})()`;

const result = eval(engine + '\n' + randomStateSrc + '\n' + harness);
console.log(result);
const r = JSON.parse(result);
const bad = r.issueCount > 0 || r.uniq < r.rolls || r.strongChordTonePct < 95 || r.bassLockPct < 95;
console.log(bad ? 'FAIL' : 'ALL PASS');
process.exit(bad ? 1 : 0);
