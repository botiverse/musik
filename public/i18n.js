/* ============================================================
   musik.build — i18n (i18next, vendored UMD, no build / no CDN)
   Bilingual zh / en. Static text via [data-i18n]; dynamic via t().
   Language: ?lng= → localStorage → navigator.language → 'en'.
   ============================================================ */
"use strict";

const I18N_RES = {
  en: { translation: {
    app:{ tagline:"Make a loop. Share it. See who picks it up.",
          positioning:"Make a loop. Share it. See who picks it up." },
    lang:{ toggle:"中" },
    account:{ logout:"Log out" },
    transport:{ play:"Play selected section", bpm:"BPM", swing:"Swing", dark:"🌙 Dark", bright:"☀️ Light" },
    actor:{ switchTitle:"Account", liveLocked:"Identity comes from your sign-in",
            now:"Now acting as {{who}}", switchDemo:"Switch (demo)" },
    graph:{ title:"🧩 Loop Graph", hint:"node = a loop · edge = next section · branch = pick one at random · the whole graph is a song",
            addNode:"＋ Add section", playSong:"▶ Whole song", stopSong:"■ Stop", exportSong:"⬇ Export song",
            align:"Align tempo", alignTitle:"Force all sections to one tempo when playing the whole song",
            noSections:"No sections in the graph yet" },
    board:{ editing:"✎ Editing:", flip:"↪ Flip a take", publish:"⬆ Publish", published:"● Published",
            export:"⬇ Export", clear:"🧹 Clear", starter:"🎲 Feeling lucky",
            note:"click cells to play · drag to paint · double-click VOX to add words · every step is logged to this song",
            proposal:"(draft)" },
    sec:{ drums:"punchy drum kit", k808:"sliding sub bass · paint adjacent cells = a glide", keys:"melody / pad · pentatonic guardrails",
          bars:"vocal line · one cell = a syllable, double-click to write words", word:"vox" },
    crew:{ title:"🎛 Crew", badge:"RAFT AGENTS",
           sub:"Agent bandmates drop <b>draft proposals</b> into the selected section; @Arranger adds <b>variant sections</b> to the whole song. Anything you accept is logged under the agent's identity.",
           arrange:"✨ @Arranger: branch this into two variants", accept:"✓ Accept", reject:"✗ Erase",
           ready:"Crew is here",
           greet:"Welcome 🎵 hit ▶ to hear the selected section, or let me lay down a groove; the Loop Graph below links sections into a song." },
    agents:{ beat:"trap/boom drums", k808:"sliding bass", hook:"melody hook", flow:"flow / rhyme spots" },
    history:{ title:"📋 This song's history", steps:"steps", sub:"Every step by humans and agents on this song (who / what / when).",
              empty:"No steps yet — try drawing something" },
    feed:{ title:"🌊 Jam Feed", sub:"Published pieces — anyone / any agent can ↪ Flip and keep going",
           empty:"No published pieces yet — make one and hit Publish 🌊",
           preview:"▶ Preview", stop:"■", flip:"↪ Flip", sections:"🧩 {{n}} sections", flipped:"↪ flipped" },
    footer:"musik.build",
    login:{ blurb:"Make a loop. Share it. See who picks it up.", cta:"Login with Raft →" },
    node:{ verse:"A · Verse", chorus:"B · Chorus", section:"Section {{letter}}", flipSuffix:"flip", wordPrompt:"Write a word/syllable for beat {{n}}:", renamePrompt:"Rename this section:", renameHint:"Double-click to rename" },
    toast:{ newSong:"New song «{{title}}» 🎵", addSection:"Added section «{{name}}» 🧩", pickSection:"Select a section first",
            emptyCanvas:"It's empty — draw something first", publishOk:"Published to Jam Feed 🌊", unpublishOk:"Removed from the feed",
            flipOk:"↪ Flipped — this one's yours to continue", notYours:"This song isn't yours — hit ↪ Flip to make your own copy",
            renderWav:"Rendering selected section WAV…", renderSong:"Rendering whole-song WAV…", noSections:"No sections in the graph",
            saveFail:"Save failed: {{err}}" },
    chat:{ ready:"Crew is here", accepted:"Got it 🤝", erased:"Erased — let me rethink.",
           nodeIn:"«{{name}}» is in the song now 🤝",
           beatTrap:"Laid down a trap groove with a little hi-hat roll.", beatBoom:"A boom-bap kick/snare skeleton.",
           bass808:"808 follows the key; held notes glide across cells.", hook:"Wrote a hook melody, strong beats land in-key.",
           flow:"Set a flow skeleton (syllable spots) — double-click cells to write words, rhyme spots around beats 4/8/12.",
           arrange:"Branched «{{name}}» two ways: {{list}}. They're dashed — click a node to preview, ✓ keep / ✗ erase." },
    variant:{ variation:"′ variation", varDesc:"shift a few notes, add tight hats",
              lift:"↑ lift", liftDesc:"raise the melody, full drums, +octave 808",
              brk:"· break", brkDesc:"drop most drums, keep half a line, breathe" },
    op:{ create_loop:"created the song", fork:"flipped", publish:"published", unpublish:"unpublished",
         update_node:"edited a section", add_node:"added a section", remove_node:"removed a section",
         paint:"edited a section", erase:"cleared a section", agent_fill:"filled in", arrange:"branched variants",
         add_edge:"linked sections", remove_edge:"unlinked", set_start:"set the start", set_reps:"set repeats",
         set_tempo:"changed tempo", set_mood:"changed mood", write_bar:"wrote words", clear:"cleared the canvas", rename:"renamed", set_align:"set whole-song tempo" }
  }},
  zh: { translation: {
    app:{ tagline:"做一段，分享出去，看谁接力。",
          positioning:"做一段，分享出去，看谁接力。" },
    lang:{ toggle:"EN" },
    account:{ logout:"退出登录" },
    transport:{ play:"播放选中段落", bpm:"BPM", swing:"Swing", dark:"🌙 暗", bright:"☀️ 亮" },
    actor:{ switchTitle:"账号", liveLocked:"身份由你的登录决定",
            now:"现在以 {{who}} 身份操作", switchDemo:"切换身份（演示）" },
    graph:{ title:"🧩 Loop Graph", hint:"节点=一段 loop · 连线=下一段 · 分叉=每次随机走一条 · 整张图是一首歌",
            addNode:"＋ 加段落", playSong:"▶ 整首", stopSong:"■ 停止", exportSong:"⬇ 整首导出",
            align:"统一速度", alignTitle:"播放整首时把所有段落强制到同一速度",
            noSections:"图里还没有段落" },
    board:{ editing:"✎ 正在编辑：", flip:"↪ 接力一版", publish:"⬆ 发布", published:"● 已发布",
            export:"⬇ 导出", clear:"🧹 清空", starter:"🎲 试试手气",
            note:"点格出声 · 拖动连画 · VOX 双击写词 · 每步都记进这首歌的历史",
            proposal:"(提案)" },
    sec:{ drums:"打击组", k808:"滑音贝斯 · 一格连着画 = glide 长音", keys:"旋律/铺底 · 五声护栏",
          bars:"人声轨 · 点格=一个音节，双击写词", word:"词" },
    crew:{ title:"🎛 Crew", badge:"RAFT AGENTS",
           sub:"Agent 乐队成员往<b>选中段落</b>出提案；@Arranger 直接给整首接<b>变体段落</b>。接受的都以 agent 身份记进历史。",
           arrange:"✨ @Arranger 给这段接两个变体", accept:"✓ 接受", reject:"✗ 擦掉",
           ready:"Crew 已就位",
           greet:"欢迎 🎵 点 ▶ 听选中段落，或让我铺个 groove；下面 Loop Graph 把段落连成一首歌。" },
    agents:{ beat:"trap/boom 鼓", k808:"滑音贝斯", hook:"旋律 hook", flow:"flow/押韵位" },
    history:{ title:"📋 这首歌的历史", steps:"步", sub:"这首歌上，人和 Agent 的每一步操作（谁 / 做了什么 / 何时）。",
              empty:"还没有操作 —— 画点东西试试" },
    feed:{ title:"🌊 Jam Feed", sub:"发布的作品 —— 任何人 / Agent 都可以 ↪ 接力继续做",
           empty:"还没有发布的作品 —— 做一首然后点发布 🌊",
           preview:"▶ 试听", stop:"■", flip:"↪ 接力", sections:"🧩 {{n}} 段", flipped:"↪ 接力作品" },
    footer:"musik.build",
    login:{ blurb:"做一段，分享出去，看谁接力。", cta:"Login with Raft →" },
    node:{ verse:"A · 主歌", chorus:"B · 副歌", section:"段落 {{letter}}", flipSuffix:"接力版", wordPrompt:"给第 {{n}} 拍写一个词/音节：", renamePrompt:"给这段改个名字：", renameHint:"双击改名" },
    toast:{ newSong:"新建「{{title}}」🎵", addSection:"加了段落「{{name}}」🧩", pickSection:"先选一个段落",
            emptyCanvas:"还是空的 —— 先画点东西", publishOk:"已发布到 Jam Feed 🌊", unpublishOk:"已从 Feed 撤下",
            flipOk:"↪ 接力成功 —— 这首归你继续做", notYours:"这首歌不是你的 —— 点 ↪ 接力做一版自己的再改",
            renderWav:"渲染选中段落 WAV…", renderSong:"渲染整首 WAV…", noSections:"图里没有段落",
            saveFail:"保存失败：{{err}}" },
    chat:{ ready:"Crew 已就位", accepted:"收下了 🤝", erased:"擦掉，再想想。",
           nodeIn:"「{{name}}」收进歌里了 🤝",
           beatTrap:"铺了个 trap groove，踩镲带了点碎 roll。", beatBoom:"boom-bap 的 kick/snare 骨架。",
           bass808:"808 跟着调性走，长音连了格子做 glide。", hook:"写了句 hook 旋律，强拍落在调内。",
           flow:"摆了个 flow 骨架（音节落点），双击格子填词，押韵位在 4/8/12 拍附近。",
           arrange:"从「{{name}}」接了两个方向：{{list}}。虚线的——点节点试听，✓收下 ✗擦掉。" },
    variant:{ variation:"′ 变奏", varDesc:"挪几个音、加碎 hat", lift:"↑ 拉起", liftDesc:"旋律抬高、鼓打满、808 加八度",
              brk:"· 留白", brkDesc:"抽掉大部分鼓、留半句，喘口气" },
    op:{ create_loop:"建了这首歌", fork:"接力了", publish:"发布了", unpublish:"撤下了",
         update_node:"改了段落", add_node:"加了段落", remove_node:"删了段落",
         paint:"改了段落", erase:"清了段落", agent_fill:"填充了", arrange:"接了变体",
         add_edge:"连了线", remove_edge:"断了线", set_start:"设了起点", set_reps:"调了循环",
         set_tempo:"调了速度", set_mood:"调了调性", write_bar:"写了词", clear:"清了画布", rename:"改了名", set_align:"设了整首速度" }
  }}
};

let _t = (k)=>k;
function t(key, opts){ return _t(key, opts); }

function detectLang(){
  const q=new URLSearchParams(location.search).get('lng');
  if(q) return q.startsWith('zh')?'zh':'en';
  const saved=localStorage.getItem('rap.lang');
  if(saved) return saved;
  const nav=(navigator.language||'en').toLowerCase();
  return nav.startsWith('zh')?'zh':'en';
}

function applyI18n(root){
  (root||document).querySelectorAll('[data-i18n]').forEach(el=>{
    const key=el.getAttribute('data-i18n');
    if(el.hasAttribute('data-i18n-html')) el.innerHTML=t(key); else el.textContent=t(key);
  });
  (root||document).querySelectorAll('[data-i18n-title]').forEach(el=>{
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
  document.documentElement.lang = i18next.language==='zh'?'zh-CN':'en';
}

async function initI18n(){
  await i18next.init({ lng:detectLang(), fallbackLng:'en', resources:I18N_RES, interpolation:{escapeValue:false} });
  _t = i18next.t.bind(i18next);
  applyI18n();
}
function setLang(lng){ localStorage.setItem('rap.lang', lng);
  i18next.changeLanguage(lng, ()=>{ applyI18n(); if(window.onLangChange) window.onLangChange(); }); }
function toggleLang(){ setLang(i18next.language==='zh'?'en':'zh'); }
