/* ============================================================
   script.js — UI, flashcards, review, words list, folders
   Depends on: db.js (DB, UNCAT), import.js (ImportLogic, Importer), SheetJS (XLSX)
   ============================================================ */
'use strict';

const S = {
  folders:[], words:[], byId:new Map(),
  folder:null,                 // null = All Vocabulary
  view:'dashboard',
  // study
  mode:'all', deck:[], idx:0, flipped:false, finished:false, deckBuilt:false, busy:false,
  stats:{easy:0,hard:0,again:0,skipped:0,missed:[]}, knownIds:new Set(),
  // words
  q:'', level:'', sort:'jp', page:1, selected:new Set()
};
const PAGE_SIZE = 50, RANDOM_COUNT = 20;
const STATUS_TH = { new:'ยังไม่เคยเรียน', easy:'จำได้', hard:'ยังไม่แม่น', again:'จำไม่ได้' };

/* ---------- small helpers ---------- */
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDate = t => t ? new Date(t).toLocaleString('th-TH',{dateStyle:'medium',timeStyle:'short'}) : '—';
const sameDay = (a,b) => new Date(a).toDateString() === new Date(b).toDateString();

function toast(msg, kind=''){
  const el = document.createElement('div'); el.className = 'toast ' + kind; el.textContent = msg;
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), kind==='err' ? 7000 : 3500);
}
function openModal(html, closeOnBackdrop=true){
  const wrap = document.createElement('div'); wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  $('#modalRoot').appendChild(wrap);
  wrap.close = () => wrap.remove();
  if(closeOnBackdrop) wrap.addEventListener('mousedown', e => { if(e.target === wrap) wrap.close(); });
  const first = $('input,select,textarea,button', wrap); if(first) first.focus();
  return wrap;
}
const modalOpen = () => !!$('.modal-wrap');
function confirmDialog(title, bodyHtml, okLabel='ยืนยัน', danger=false){
  return new Promise(resolve => {
    const m = openModal(`<h3>${esc(title)}</h3><div>${bodyHtml}</div>
      <div class="foot"><button class="btn" data-r="0">ยกเลิก</button><button class="btn ${danger?'danger':'primary'}" data-r="1">${esc(okLabel)}</button></div>`, false);
    m.addEventListener('click', e => { const b = e.target.closest('[data-r]'); if(!b) return; m.close(); resolve(b.dataset.r === '1'); });
  });
}
function download(filename, blob){
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function shuffle(arr){ const a = arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
/** Weighted random order (Efraimidis–Spirakis): weak words tend to appear earlier, but every word appears exactly once. */
function weightedShuffle(list){
  const W = { again:4, hard:2.5, new:1.5, easy:1 };
  return list.map(w => ({ w, k:Math.pow(Math.random(), 1/(W[w.status]||1)) })).sort((a,b) => b.k-a.k).map(x => x.w);
}

/* ---------- data loading ---------- */
async function reload(){
  S.folders = await DB.getFolders();
  S.folders.sort((a,b) => (a.name===UNCAT) - (b.name===UNCAT) || a.createdAt - b.createdAt || a.name.localeCompare(b.name,'th'));
  S.words = await DB.getWords();
  S.byId = new Map(S.words.map(w => [w.id, w]));
  if(S.folder && !S.folders.some(f => f.name === S.folder)) { S.folder = null; S.deckBuilt = false; }
  S.selected = new Set([...S.selected].filter(id => S.byId.has(id)));
  // keep current study deck consistent with deletions without disturbing the current position
  const before = S.deck.slice(), cur = before[S.idx];
  S.deck = before.filter(id => S.byId.has(id));
  if(S.deck.length !== before.length){
    const ni = S.deck.indexOf(cur);
    S.idx = ni >= 0 ? ni : Math.min(S.idx, Math.max(0, S.deck.length-1));
    if(ni < 0) S.flipped = false;
    if(S.deck.length === 0) S.finished = false;
  }
}
async function refreshAll(){ await reload(); renderFolders(); renderCurrent(); checkNewWords(); }

const scopeWords = () => S.folder ? S.words.filter(w => w.folder === S.folder) : S.words;
const countIn = name => S.words.reduce((n,w) => n + (w.folder === name), 0);

/* ---------- navigation ---------- */
const TITLES = { dashboard:'หน้าแรก', study:'เรียน Flashcard', words:'คำศัพท์', backup:'สำรองข้อมูล' };
function setView(v){
  S.view = v;
  $$('.view').forEach(s => s.hidden = s.id !== 'view-' + v);
  $$('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  $('#topTitle').textContent = TITLES[v];
  $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('on');
  renderCurrent();
  window.scrollTo(0,0);
}
function renderCurrent(){
  $('#topFolder').textContent = S.folder ? '📁 ' + S.folder : 'All Vocabulary';
  if(S.view === 'dashboard') renderDashboard();
  else if(S.view === 'study'){ if(!S.deckBuilt) startRound(); renderStudy(); }
  else if(S.view === 'words') renderWords();
  else if(S.view === 'backup') renderBackup();
}
function selectFolder(name){
  S.folder = name; S.page = 1; S.selected.clear(); S.deckBuilt = false;
  if(S.view === 'backup') S.view = 'words';
  setView(S.view); renderFolders();
}

/* ---------- folders ---------- */
function renderFolders(){
  const li = (name, label, count, extra='') => `<li class="${S.folder===name?'on':''}" data-folder="${name===null?'':esc(name)}" data-all="${name===null}">
      <button class="fname" data-act="pick">${label}</button><span class="count">${count}</span>${extra}</li>`;
  const actions = n => n === UNCAT ? '' :
    `<button class="fact" data-act="rename" title="เปลี่ยนชื่อ" aria-label="เปลี่ยนชื่อ ${esc(n)}">✎</button><button class="fact" data-act="delfolder" title="ลบโฟลเดอร์" aria-label="ลบ ${esc(n)}">🗑</button>`;
  $('#folderList').innerHTML = li(null, '📚 All Vocabulary', S.words.length) + '<div class="sep"></div>' +
    S.folders.map(f => li(f.name, '📁 ' + esc(f.name), countIn(f.name), actions(f.name))).join('');
}
$('#folderList').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if(!b) return;
  const li = b.closest('li'), name = li.dataset.all === 'true' ? null : li.dataset.folder;
  if(b.dataset.act === 'pick') selectFolder(name);
  else if(b.dataset.act === 'rename') renameFolderDialog(name);
  else if(b.dataset.act === 'delfolder') deleteFolderDialog(name);
});
$('#addFolderBtn').onclick = () => folderNameDialog('สร้างโฟลเดอร์ใหม่', '', async name => {
  await DB.addFolder(name); await reload(); selectFolder(name.trim()); toast('สร้างโฟลเดอร์แล้ว','ok');
});
function renameFolderDialog(old){
  folderNameDialog('เปลี่ยนชื่อโฟลเดอร์', old, async name => {
    await DB.renameFolder(old, name);
    if(S.folder === old) S.folder = name.trim();
    await refreshAll(); toast('เปลี่ยนชื่อแล้ว','ok');
  });
}
function folderNameDialog(title, value, onSave){
  const m = openModal(`<h3>${esc(title)}</h3><label class="muted small">ชื่อโฟลเดอร์</label>
    <input type="text" id="fnIn" maxlength="60" value="${esc(value)}"><div class="err" id="fnErr" style="color:var(--red);min-height:1.2em"></div>
    <div class="foot"><button class="btn" data-r="0">ยกเลิก</button><button class="btn primary" data-r="1">บันทึก</button></div>`);
  const input = $('#fnIn', m); input.select();
  const save = async () => {
    try{ await onSave(input.value); m.close(); }catch(e){ $('#fnErr', m).textContent = e.message; }
  };
  m.addEventListener('click', e => { const b = e.target.closest('[data-r]'); if(b) b.dataset.r === '1' ? save() : m.close(); });
  input.addEventListener('keydown', e => { if(e.key === 'Enter') save(); });
}
async function deleteFolderDialog(name){
  const n = countIn(name);
  if(n === 0){
    if(await confirmDialog('ลบโฟลเดอร์', `ลบโฟลเดอร์ <b>${esc(name)}</b> ? (ไม่มีคำศัพท์ในโฟลเดอร์นี้)`, 'ลบโฟลเดอร์', true)){
      await DB.deleteFolder(name,'move'); await refreshAll(); toast('ลบโฟลเดอร์แล้ว','ok');
    }
    return;
  }
  const m = openModal(`<h3>ลบโฟลเดอร์ “${esc(name)}”</h3>
    <p>โฟลเดอร์นี้มีคำศัพท์ <b>${n}</b> คำ — เลือกว่าจะจัดการอย่างไร:</p>
    <label class="radio"><input type="radio" name="dm" value="move" checked> ย้ายคำศัพท์ทั้งหมดไปที่ <b>Uncategorized</b> (ไม่สูญเสียข้อมูล)</label>
    <label class="radio"><input type="radio" name="dm" value="delete"> <b style="color:var(--red)">ลบคำศัพท์ทั้ง ${n} คำด้วย</b> (กู้คืนไม่ได้ นอกจากมีไฟล์สำรอง)</label>
    <div class="foot"><button class="btn" data-r="0">ยกเลิก</button><button class="btn danger" data-r="1">ลบโฟลเดอร์</button></div>`, false);
  m.addEventListener('click', async e => {
    const b = e.target.closest('[data-r]'); if(!b) return;
    if(b.dataset.r === '0') return m.close();
    const mode = $('input[name=dm]:checked', m).value;
    try{ await DB.deleteFolder(name, mode); m.close(); await refreshAll();
      toast(mode === 'delete' ? `ลบโฟลเดอร์และคำศัพท์ ${n} คำแล้ว` : `ลบโฟลเดอร์แล้ว ย้าย ${n} คำไป Uncategorized`, 'ok');
    }catch(err){ toast(err.message, 'err'); }
  });
}

/* ---------- dashboard ---------- */
function renderDashboard(){
  const ws = scopeWords(), all = S.words.length;
  $('#dashScope').textContent = S.folder ? `สถิติของโฟลเดอร์: ${S.folder}` : 'สถิติของคำศัพท์ทั้งหมด (All Vocabulary)';
  const nNew = ws.filter(w => !w.reviewCount).length, easy = ws.filter(w => w.status==='easy').length;
  const rev = ws.filter(w => w.status==='hard' || w.status==='again').length;
  const today = ws.filter(w => w.lastReview && sameDay(w.lastReview, Date.now())).length;
  const card = (v,l,c='') => `<div class="stat ${c}"><b>${v}</b><span>${l}</span></div>`;
  $('#dashStats').innerHTML = card(ws.length,'คำศัพท์ทั้งหมด') + card(S.folders.length,'โฟลเดอร์') + card(nNew,'คำใหม่ (ยังไม่เคยทบทวน)') +
    card(easy,'จำได้','green') + card(rev,'ต้องทบทวน','red') + card(today,'ฝึกวันนี้');
  const pct = ws.length ? Math.round(easy / ws.length * 100) : 0;
  $('#dashPct').textContent = `${pct}% (${easy}/${ws.length})`; $('#dashBar').style.width = pct + '%';
  $('#dashEmpty').innerHTML = all === 0 ? `<div class="empty"><div class="big">単</div>
    <p><b>ยังไม่มีคำศัพท์</b><br>เริ่มต้นโดยนำเข้าไฟล์ Excel ตาม Template หรือเพิ่มคำศัพท์ด้วยตัวเอง</p>
    <div class="actions"><button class="btn primary" data-go="import">📥 Import Excel</button><button class="btn" data-go="add">＋ เพิ่มคำศัพท์</button>
    <a class="btn" href="Japanese_Thai_Vocabulary_Template.xlsx" download>⬇ ดาวน์โหลด Template</a></div></div>` : '';
}
$('#dashStart').onclick = () => {
  if(!scopeWords().length){ toast('ยังไม่มีคำศัพท์ในขอบเขตที่เลือก — เพิ่มหรือนำเข้าก่อน','err'); return; }
  S.mode = 'all'; $('#modeSel').value = 'all'; S.deckBuilt = false; setView('study');
};
$('#dashImport').onclick = $('#wordsImport').onclick = () => $('#excelFile').click();
$('#dashAdd').onclick = $('#wordsAdd').onclick = () => openWordForm(null);
$('#dashEmpty').addEventListener('click', e => {
  const b = e.target.closest('[data-go]'); if(!b) return;
  b.dataset.go === 'import' ? $('#excelFile').click() : openWordForm(null);
});

/* ============================================================
   STUDY — rounds, flip, rating
   ============================================================ */
function eligible(){
  const ws = scopeWords();
  switch(S.mode){
    case 'new': return ws.filter(w => !w.reviewCount);
    case 'review': return ws.filter(w => w.status==='hard' || w.status==='again');
    case 'learned': return ws.filter(w => w.status==='easy');
    default: return ws;                       // 'all' and 'random'
  }
}
/** Build a fresh round. ids (optional) = explicit list of word ids (used for "review this round's misses"). */
function startRound(ids){
  const pool = ids ? ids.map(id => S.byId.get(id)).filter(Boolean) : eligible();
  let order;
  if(ids) order = shuffle(pool);
  else if(S.mode === 'random') order = shuffle(pool).slice(0, RANDOM_COUNT);
  else order = weightedShuffle(pool);
  S.deck = order.map(w => w.id); S.idx = 0; S.flipped = false; S.finished = false; S.deckBuilt = true;
  S.stats = { easy:0, hard:0, again:0, skipped:0, missed:[] };
  S.knownIds = new Set(eligible().map(w => w.id));
  $('#newWordsBanner').hidden = true;
}
/** After data changes mid-round: don't touch the deck, just tell the user about newly eligible words. */
function checkNewWords(){
  const b = $('#newWordsBanner');
  if(!S.deckBuilt || S.mode === 'random'){ b.hidden = true; return; }
  const fresh = eligible().filter(w => !S.knownIds.has(w.id)).length;
  if(!fresh){ b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = `ℹ️ มีคำศัพท์ใหม่ ${fresh} คำที่เข้าเงื่อนไขของชุดนี้ — จะไม่แทรกกลางรอบ <button class="btn" id="bnRestart">เริ่มรอบใหม่เพื่อรวมคำใหม่</button>`;
  $('#bnRestart').onclick = () => { startRound(); renderStudy(); };
}
const curWord = () => S.byId.get(S.deck[S.idx]);

function renderStudy(){
  const area = $('#studyArea'), ws = scopeWords();
  $('#studyScope').textContent = `📁 ${S.folder || 'All Vocabulary'} · ชุดนี้ ${S.deck.length} คำ`;
  if(!S.deck.length){
    const none = ws.length === 0;
    const msg = none ? 'ยังไม่มีคำศัพท์ในโฟลเดอร์นี้' : {
      new:'ไม่มีคำใหม่ที่ยังไม่เคยทบทวน', review:'ไม่มีคำที่ต้องทบทวน — เยี่ยมมาก!', learned:'ยังไม่มีคำที่ประเมินว่าจำได้', all:'ไม่มีคำศัพท์', random:'ไม่มีคำศัพท์'
    }[S.mode];
    area.innerHTML = `<div class="empty"><div class="big">単</div><p><b>${msg}</b><br>${none ? 'นำเข้าจาก Excel หรือเพิ่มคำศัพท์เพื่อเริ่มเรียน' : 'ลองเปลี่ยนโหมดการเรียน'}</p>
      <div class="actions">${none ? '<button class="btn primary" data-go="import">📥 Import Excel</button><button class="btn" data-go="add">＋ เพิ่มคำศัพท์</button>'
      : '<button class="btn primary" data-go="all">เรียนทุกคำ (All Cards)</button>'}</div></div>`;
    return;
  }
  if(S.finished){ renderFinished(area); return; }
  const w = curWord(); if(!w){ S.finished = true; renderFinished(area); return; }
  const total = S.deck.length, pct = Math.round((S.idx+1) / total * 100);
  const canSpeak = 'speechSynthesis' in window;
  const spk = canSpeak ? `<button class="speak" data-act="speak" aria-label="ฟังเสียงอ่าน">🔊 ฟังเสียง</button>` : '';
  area.innerHTML = `
    <div class="counter"><span>การ์ด ${S.idx+1} / ${total}</span><span>${pct}%</span></div>
    <div class="bar"><div style="width:${(S.idx+1)/total*100}%"></div></div>
    <div class="scene"><div class="card ${S.flipped?'flipped':''}" id="card" tabindex="0" role="button" aria-label="พลิกการ์ด">
      <div class="face front">
        <div class="jp-big" lang="ja">${esc(w.japanese)}</div>${spk}
        <div class="hint">แตะเพื่อดูคำตอบ <small>(Space)</small></div>
      </div>
      <div class="face back">
        <h2 lang="ja">${esc(w.japanese)}</h2>
        ${w.kana ? `<div class="kana" lang="ja">${esc(w.kana)}</div>` : ''}
        <div class="thai">${esc(w.thai)}</div>
        ${w.romaji ? `<div class="romaji">${esc(w.romaji)}</div>` : ''}
        ${w.exJp || w.exTh ? `<div class="ex">${w.exJp ? `<div class="jp" lang="ja">${esc(w.exJp)}</div>` : ''}${w.exTh ? `<div>${esc(w.exTh)}</div>` : ''}</div>` : ''}
        ${w.notes ? `<div class="note">📝 ${esc(w.notes)}</div>` : ''}
        <div class="meta"><span class="pill ${w.status}">${STATUS_TH[w.status]||''}</span><span>เรียนแล้ว ${w.reviewCount||0} ครั้ง</span>
          <span>ทบทวนล่าสุด: ${fmtDate(w.lastReview)}</span><span>📁 ${esc(w.folder)}</span>${w.level ? `<span>${esc(w.level)}</span>` : ''}
          ${spk ? '<button class="speak" data-act="speak" style="margin:0;padding:4px 12px;min-height:34px">🔊</button>' : ''}</div>
      </div>
    </div></div>
    <div class="rate">
      <button class="again" data-rate="again" ${S.flipped?'':'disabled'}>❌ จำไม่ได้<small>Again</small></button>
      <button class="hard" data-rate="hard" ${S.flipped?'':'disabled'}>🤔 ยังไม่แม่น<small>Hard</small></button>
      <button class="easy" data-rate="easy" ${S.flipped?'':'disabled'}>✅ จำได้<small>Easy</small></button>
    </div>
    <div class="ctrl" style="margin-top:14px">
      <button class="btn" data-act="prev" ${S.idx===0?'disabled':''}>◀ ก่อนหน้า</button>
      <button class="btn primary" data-act="flip">🔄 Flip</button>
      <button class="btn" data-act="skip">⏭ Skip</button>
      <button class="btn" data-act="next">ถัดไป ▶</button>
    </div>
    <div class="ctrl"><button class="btn" data-act="shuffle">🔀 Shuffle ที่เหลือ</button><button class="btn" data-act="restart">↺ เริ่มรอบใหม่</button></div>
    <div class="kbd">คีย์ลัด: Space = พลิก · ← ก่อนหน้า · → ถัดไป</div>`;
}
function renderFinished(area){
  const s = S.stats, n = S.deck.length;
  area.innerHTML = `<div class="panel" style="text-align:center"><div class="big" style="font-family:var(--serif);font-size:2.6rem;color:var(--red)">完</div>
    <h2 style="margin:.2rem 0">จบรอบแล้ว 🎉</h2><p class="muted">ชุดนี้มี ${n} คำ</p>
    <div class="sumgrid"><div><b style="color:var(--green)">${s.easy}</b>จำได้</div><div><b style="color:var(--amber)">${s.hard}</b>ยังไม่แม่น</div>
      <div><b style="color:var(--red)">${s.again}</b>จำไม่ได้</div><div><b>${s.skipped}</b>ข้าม</div></div>
    <div class="actions" style="justify-content:center"><button class="btn primary" data-act="restart">↺ เริ่มรอบใหม่ (สุ่มลำดับใหม่)</button>
      ${s.missed.length ? `<button class="btn" data-act="missed">ทบทวนคำที่ยังไม่แม่นในรอบนี้ (${s.missed.length})</button>` : ''}
      <button class="btn" data-act="prev">◀ ย้อนดูการ์ดสุดท้าย</button></div></div>`;
}
function flip(){
  if(S.finished || !S.deck.length) return;
  S.flipped = !S.flipped;
  const c = $('#card'); if(!c) return;
  c.classList.toggle('flipped', S.flipped);
  $$('[data-rate]').forEach(b => b.disabled = !S.flipped);
}
function go(delta){
  if(!S.deck.length) return;
  if(S.finished){ if(delta < 0){ S.finished = false; S.idx = S.deck.length - 1; } }
  else if(delta > 0){ if(S.idx >= S.deck.length-1) S.finished = true; else S.idx++; }
  else if(S.idx > 0) S.idx--;
  else return;
  S.flipped = false; renderStudy();
}
async function rate(kind){
  const w = curWord(); if(!w || !S.flipped || S.busy) return;
  S.busy = true;
  try{
    w.status = kind; w.reviewCount = (w.reviewCount||0) + 1; w.lastReview = Date.now();
    await DB.saveWord(w);
    S.stats[kind]++; if(kind !== 'easy' && !S.stats.missed.includes(w.id)) S.stats.missed.push(w.id);
    go(1);
  }catch(e){ toast('บันทึกผลไม่สำเร็จ: ' + e.message, 'err'); }
  finally{ S.busy = false; }
}
$('#studyArea').addEventListener('click', e => {
  const g = e.target.closest('[data-go]');
  if(g){ if(g.dataset.go === 'import') $('#excelFile').click(); else if(g.dataset.go === 'add') openWordForm(null);
         else { S.mode = 'all'; $('#modeSel').value = 'all'; startRound(); renderStudy(); } return; }
  const r = e.target.closest('[data-rate]'); if(r){ rate(r.dataset.rate); return; }
  const a = e.target.closest('[data-act]');
  if(a){
    e.stopPropagation();
    switch(a.dataset.act){
      case 'flip': flip(); break;
      case 'next': go(1); break;
      case 'prev': go(-1); break;
      case 'skip': S.stats.skipped++; go(1); break;
      case 'speak': { const w = curWord(); if(w) speak(w.kana || w.japanese); break; }
      case 'shuffle': {
        const head = S.deck.slice(0, S.idx+1), tail = shuffle(S.deck.slice(S.idx+1));
        S.deck = head.concat(tail); toast('สุ่มลำดับการ์ดที่เหลือใหม่แล้ว'); renderStudy(); break; }
      case 'restart': startRound(); renderStudy(); break;
      case 'missed': startRound(S.stats.missed.slice()); renderStudy(); break;
    }
    return;
  }
  if(e.target.closest('#card')) flip();
});
$('#modeSel').onchange = e => { S.mode = e.target.value; startRound(); renderStudy(); };
document.addEventListener('keydown', e => {
  if(S.view !== 'study' || modalOpen() || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  if(e.key === ' ' || e.code === 'Space'){ e.preventDefault(); flip(); }
  else if(e.key === 'ArrowRight') go(1);
  else if(e.key === 'ArrowLeft') go(-1);
});
function speak(text){
  if(!('speechSynthesis' in window)){ toast('เบราว์เซอร์นี้ไม่รองรับเสียงอ่าน','err'); return; }
  const voices = speechSynthesis.getVoices(), v = voices.find(v => /^ja/i.test(v.lang));
  if(voices.length && !v){ toast('อุปกรณ์นี้ไม่มีเสียงภาษาญี่ปุ่น — ติดตั้ง Voice ภาษาญี่ปุ่นในระบบปฏิบัติการ','err'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text); u.lang = 'ja-JP'; u.rate = .85; if(v) u.voice = v;
  speechSynthesis.speak(u);
}

/* ============================================================
   WORDS — list, search, filter, sort, edit, delete, move
   ============================================================ */
function filteredWords(){
  const q = DB.norm(S.q);
  let list = scopeWords().filter(w =>
    (!S.level || w.level === S.level) &&
    (!q || [w.japanese, w.kana, w.romaji, w.thai].some(x => DB.norm(x).includes(q))));
  const cmp = {
    jp:(a,b) => (a.kana||a.japanese).localeCompare(b.kana||b.japanese,'ja'),
    th:(a,b) => a.thai.localeCompare(b.thai,'th'),
    new:(a,b) => b.createdAt - a.createdAt || b.id - a.id,
    old:(a,b) => a.createdAt - b.createdAt || a.id - b.id
  }[S.sort];
  return list.sort(cmp);
}
function renderWords(){
  const levels = [...new Set(scopeWords().map(w => w.level).filter(Boolean))].sort();
  if(S.level && !levels.includes(S.level)) S.level = '';
  $('#fLevel').innerHTML = '<option value="">JLPT: ทุกระดับ</option>' + levels.map(l => `<option ${l===S.level?'selected':''} value="${esc(l)}">${esc(l)}</option>`).join('');
  $('#fSort').value = S.sort;
  const list = filteredWords(), pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  S.page = Math.min(S.page, pages);
  const slice = list.slice((S.page-1)*PAGE_SIZE, S.page*PAGE_SIZE);
  $('#wbody').innerHTML = slice.length ? slice.map(w => `<tr data-id="${w.id}">
      <td><input type="checkbox" data-sel="${w.id}" ${S.selected.has(w.id)?'checked':''} aria-label="เลือก ${esc(w.japanese)}"></td>
      <td><div class="jp" lang="ja">${esc(w.japanese)}</div>${w.kana ? `<div class="kn" lang="ja">${esc(w.kana)}</div>` : ''}</td>
      <td class="c-th">${esc(w.thai)}</td><td class="c-f">📁 ${esc(w.folder)}</td>
      <td class="c-l">${w.level ? esc(w.level) : ''}</td><td class="c-s"><span class="pill ${w.status}">${STATUS_TH[w.status]||''}</span></td>
      <td class="acts"><button data-act="view" title="ดูรายละเอียด" aria-label="ดูรายละเอียด">👁</button><button data-act="edit" title="แก้ไข" aria-label="แก้ไข">✎</button><button data-act="del" title="ลบ" aria-label="ลบ">🗑</button></td></tr>`).join('')
    : `<tr><td colspan="7"><div class="empty" style="border:0">${S.words.length === 0
        ? '<div class="big">単</div><b>ยังไม่มีคำศัพท์</b><br>กด “เพิ่มคำศัพท์” หรือ “Import Excel” เพื่อเริ่มต้น'
        : 'ไม่พบคำศัพท์ที่ตรงกับการค้นหา/ตัวกรอง'}</div></td></tr>`;
  $('#selAll').checked = slice.length > 0 && slice.every(w => S.selected.has(w.id));
  // pager
  const pg = [];
  if(pages > 1){
    pg.push(`<button data-p="${S.page-1}" ${S.page===1?'disabled':''}>‹</button>`);
    const show = new Set([1, pages, S.page-1, S.page, S.page+1]); let last = 0;
    [...show].filter(p => p>=1 && p<=pages).sort((a,b)=>a-b).forEach(p => {
      if(p - last > 1) pg.push('<span class="muted">…</span>');
      pg.push(`<button data-p="${p}" class="${p===S.page?'on':''}">${p}</button>`); last = p;
    });
    pg.push(`<button data-p="${S.page+1}" ${S.page===pages?'disabled':''}>›</button>`);
  }
  $('#pager').innerHTML = pg.join('') + `<span class="muted small" style="margin-left:8px">${list.length} คำ</span>`;
  renderBulk();
}
function renderBulk(){
  const b = $('#bulkBar'), n = S.selected.size;
  b.hidden = n === 0; if(!n) return;
  b.innerHTML = `<b>เลือก ${n} คำ</b><button class="btn" data-bulk="move">📁 ย้ายไปโฟลเดอร์…</button>
    <button class="btn danger" data-bulk="del">🗑 ลบที่เลือก</button><button class="btn" data-bulk="clear">ยกเลิกการเลือก</button>`;
}
let qTimer;
$('#q').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = e.target.value; S.page = 1; renderWords(); }, 150); });
$('#fLevel').onchange = e => { S.level = e.target.value; S.page = 1; renderWords(); };
$('#fSort').onchange = e => { S.sort = e.target.value; S.page = 1; renderWords(); };
$('#pager').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if(b && !b.disabled){ S.page = +b.dataset.p; renderWords(); window.scrollTo(0,0); } });
$('#selAll').onchange = e => {
  const ids = $$('#wbody [data-sel]').map(c => +c.dataset.sel);
  ids.forEach(id => e.target.checked ? S.selected.add(id) : S.selected.delete(id)); renderWords();
};
$('#wbody').addEventListener('click', async e => {
  const sel = e.target.closest('[data-sel]');
  if(sel){ const id = +sel.dataset.sel; sel.checked ? S.selected.add(id) : S.selected.delete(id); renderBulk(); return; }
  const b = e.target.closest('[data-act]'); if(!b) return;
  const id = +b.closest('tr').dataset.id, w = S.byId.get(id); if(!w) return;
  if(b.dataset.act === 'view') showWord(w);
  else if(b.dataset.act === 'edit') openWordForm(w);
  else if(b.dataset.act === 'del'){
    if(await confirmDialog('ลบคำศัพท์', `ลบคำว่า <b lang="ja">${esc(w.japanese)}</b> (${esc(w.thai)}) ?<br><span class="muted small">ลบแล้วกู้คืนไม่ได้ นอกจากมีไฟล์สำรอง</span>`, 'ลบ', true)){
      try{ await DB.deleteWords([id]); S.selected.delete(id); await refreshAll(); toast('ลบคำศัพท์แล้ว','ok'); }catch(err){ toast(err.message,'err'); }
    }
  }
});
$('#bulkBar').addEventListener('click', async e => {
  const b = e.target.closest('[data-bulk]'); if(!b) return;
  const ids = [...S.selected];
  if(b.dataset.bulk === 'clear'){ S.selected.clear(); renderWords(); }
  else if(b.dataset.bulk === 'del'){
    if(await confirmDialog('ลบคำศัพท์ที่เลือก', `ลบคำศัพท์ <b>${ids.length}</b> คำ ? กู้คืนไม่ได้นอกจากมีไฟล์สำรอง`, 'ลบทั้งหมด', true)){
      try{ await DB.deleteWords(ids); S.selected.clear(); await refreshAll(); toast(`ลบ ${ids.length} คำแล้ว`,'ok'); }catch(err){ toast(err.message,'err'); }
    }
  } else if(b.dataset.bulk === 'move') moveDialog(ids);
});
function moveDialog(ids){
  const m = openModal(`<h3>ย้าย ${ids.length} คำ ไปโฟลเดอร์</h3>
    <label class="muted small">เลือกโฟลเดอร์ปลายทาง</label>
    <select id="mvSel" style="width:100%">${S.folders.map(f => `<option>${esc(f.name)}</option>`).join('')}</select>
    <label class="muted small" style="display:block;margin-top:12px">หรือพิมพ์ชื่อโฟลเดอร์ใหม่ (ถ้าต้องการ)</label>
    <input type="text" id="mvNew" maxlength="60" placeholder="เช่น คำศัพท์สัปดาห์นี้">
    <div class="foot"><button class="btn" data-r="0">ยกเลิก</button><button class="btn primary" data-r="1">ย้าย</button></div>`, false);
  m.addEventListener('click', async e => {
    const b = e.target.closest('[data-r]'); if(!b) return;
    if(b.dataset.r === '0') return m.close();
    const target = $('#mvNew', m).value.trim() || $('#mvSel', m).value;
    try{ await DB.moveWords(ids, target); m.close(); S.selected.clear(); await refreshAll(); toast(`ย้าย ${ids.length} คำไป “${target}” แล้ว`,'ok'); }
    catch(err){ toast(err.message,'err'); }
  });
}
function showWord(w){
  const row = (k,v) => v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '';
  const m = openModal(`<h3 lang="ja" style="font-family:var(--serif);font-size:1.8rem">${esc(w.japanese)}</h3>
    <dl class="kv">${row('Kana Reading',w.kana)}${row('Romaji',w.romaji)}${row('ความหมายไทย',w.thai)}${row('โฟลเดอร์',w.folder)}${row('JLPT',w.level)}
      ${row('ประโยคตัวอย่าง (JP)',w.exJp)}${row('คำแปลประโยค (TH)',w.exTh)}${row('Notes',w.notes)}
      <dt>สถานะ</dt><dd><span class="pill ${w.status}">${STATUS_TH[w.status]}</span></dd>
      <dt>จำนวนครั้งที่เรียน</dt><dd>${w.reviewCount||0}</dd><dt>ทบทวนล่าสุด</dt><dd>${fmtDate(w.lastReview)}</dd><dt>เพิ่มเมื่อ</dt><dd>${fmtDate(w.createdAt)}</dd></dl>
    <div class="foot">${'speechSynthesis' in window ? '<button class="btn" data-r="s">🔊 ฟังเสียง</button>' : ''}<button class="btn" data-r="e">✎ แก้ไข</button><button class="btn primary" data-r="c">ปิด</button></div>`);
  m.addEventListener('click', e => { const b = e.target.closest('[data-r]'); if(!b) return;
    if(b.dataset.r === 's') speak(w.kana || w.japanese); else if(b.dataset.r === 'e'){ m.close(); openWordForm(w); } else m.close(); });
}
function openWordForm(w){
  const f = w || {}, def = f.folder || S.folder || UNCAT;
  const m = openModal(`<h3>${w ? 'แก้ไขคำศัพท์' : 'เพิ่มคำศัพท์'}</h3>
   <div class="form">
    <label>Japanese <span class="req">*</span><input type="text" id="fJp" lang="ja" value="${esc(f.japanese)}" maxlength="200"></label>
    <label>Kana Reading<input type="text" id="fKana" lang="ja" value="${esc(f.kana)}" maxlength="200"></label>
    <label class="full">Thai Meaning <span class="req">*</span><input type="text" id="fTh" value="${esc(f.thai)}" maxlength="300"></label>
    <label>โฟลเดอร์<select id="fFolder" style="width:100%">${S.folders.map(x => `<option ${x.name===def?'selected':''}>${esc(x.name)}</option>`).join('')}</select></label>
    <label>JLPT Level<input type="text" id="fLevel2" list="lvls" value="${esc(f.level)}" maxlength="20" placeholder="N5"><datalist id="lvls"><option>N5<option>N4<option>N3<option>N2<option>N1</datalist></label>
    <label>Romaji<input type="text" id="fRomaji" value="${esc(f.romaji)}" maxlength="200"></label><span></span>
    <label class="full">Example Japanese<textarea id="fExJp" lang="ja">${esc(f.exJp)}</textarea></label>
    <label class="full">Example Thai<textarea id="fExTh">${esc(f.exTh)}</textarea></label>
    <label class="full">Notes<textarea id="fNotes">${esc(f.notes)}</textarea></label>
    <div class="err full" id="fErr"></div>
   </div>
   <div class="foot"><button class="btn" data-r="0">ยกเลิก</button>${w ? '' : '<button class="btn" data-r="more">บันทึกและเพิ่มต่อ</button>'}<button class="btn primary" data-r="1">บันทึก</button></div>`, false);
  const v = id => $('#'+id, m).value.trim();
  m.addEventListener('click', async e => {
    const b = e.target.closest('[data-r]'); if(!b) return;
    if(b.dataset.r === '0') return m.close();
    const data = { japanese:v('fJp'), kana:v('fKana'), thai:v('fTh'), folder:v('fFolder'), level:v('fLevel2'),
      romaji:v('fRomaji'), exJp:v('fExJp'), exTh:v('fExTh'), notes:v('fNotes') };
    const err = $('#fErr', m);
    if(!data.japanese || !data.thai){ err.textContent = 'กรุณากรอก Japanese และ Thai Meaning'; return; }
    const key = DB.dupKey(data.folder, data.japanese, data.kana);
    if(S.words.some(x => x.id !== (w && w.id) && DB.dupKey(x.folder, x.japanese, x.kana) === key)){
      err.textContent = 'มีคำนี้ (Folder + Japanese + Kana) อยู่แล้ว'; return; }
    try{
      await DB.saveWord(w ? Object.assign({}, w, data) : DB.blankWord(data));
      await refreshAll(); toast(w ? 'บันทึกการแก้ไขแล้ว' : 'เพิ่มคำศัพท์แล้ว', 'ok');
      if(b.dataset.r === 'more'){ m.close(); openWordForm(null); } else m.close();
    }catch(ex){ err.textContent = 'บันทึกไม่สำเร็จ: ' + ex.message; }
  });
}

/* ============================================================
   IMPORT EXCEL — preview → choose policy → confirm → summary
   ============================================================ */
$('#excelFile').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = ''; if(!file) return;
  try{
    toast('กำลังอ่านไฟล์ ' + file.name + ' …');
    const { fileName, parsed } = await Importer.readFile(file);
    importDialog(fileName, parsed);
  }catch(err){ openModal(`<h3>นำเข้าไม่สำเร็จ</h3><p style="white-space:pre-line;color:var(--red)">${esc(err.message)}</p>
    <p class="muted small">ตรวจสอบว่าไฟล์ใช้ Template: ชีต <code>Vocabulary</code> และมีหัวคอลัมน์ Japanese, Thai Meaning</p>
    <div class="foot"><button class="btn primary" onclick="this.closest('.modal-wrap').remove()">ปิด</button></div>`); }
});
function importDialog(fileName, parsed){
  const keys = new Set(S.words.map(w => DB.dupKey(w.folder, w.japanese, w.kana)));
  const { fresh, dup } = ImportLogic.classify(parsed.rows, keys, DB.dupKey);
  const newFolders = [...new Set(parsed.rows.map(r => r.folder))].filter(n => !S.folders.some(f => f.name === n));
  const errHtml = parsed.errors.length ? `<div class="errlist"><b>แถวที่มีข้อผิดพลาด (${parsed.errors.length}) — จะไม่ถูกนำเข้า</b><br>${
    parsed.errors.slice(0,100).map(x => `แถว ${x.row}: ${esc(x.reason)}`).join('<br>')}${parsed.errors.length > 100 ? '<br>…' : ''}</div>` : '';
  const prev = parsed.rows.slice(0,10).map(r => `<tr class="${r._dup?'dup':''}"><td>${esc(r.folder)}</td><td lang="ja">${esc(r.japanese)}</td><td lang="ja">${esc(r.kana)}</td><td>${esc(r.thai)}</td><td>${esc(r.level)}</td><td>${r._dup?'ซ้ำ':'ใหม่'}</td></tr>`).join('');
  const m = openModal(`<h3>ตรวจสอบก่อนนำเข้า</h3><p class="muted small">ไฟล์: ${esc(fileName)} (ไฟล์ต้นฉบับจะไม่ถูกแก้ไข)</p>
    <div class="sumgrid"><div><b>${parsed.total}</b>แถวที่พบ</div><div><b style="color:var(--green)">${parsed.rows.length}</b>ถูกต้อง</div>
      <div><b style="color:var(--red)">${parsed.errors.length}</b>ผิดพลาด</div><div><b>${fresh}</b>คำใหม่</div><div><b>${dup}</b>ซ้ำ</div></div>
    ${newFolders.length ? `<p class="small">📁 จะสร้างโฟลเดอร์ใหม่ ${newFolders.length} โฟลเดอร์: ${esc(newFolders.slice(0,8).join(', '))}${newFolders.length>8?' …':''}</p>` : ''}
    ${parsed.unknown && parsed.unknown.length ? `<p class="muted small">คอลัมน์ที่ไม่รู้จัก (ข้าม): ${esc(parsed.unknown.join(', '))}</p>` : ''}
    ${errHtml}
    ${prev ? `<b class="small">ตัวอย่าง 10 แถวแรก</b><div class="prev"><table><tr><th>Folder</th><th>Japanese</th><th>Kana</th><th>Thai</th><th>JLPT</th><th></th></tr>${prev}</table></div>` : ''}
    <p style="margin:14px 0 6px"><b>เมื่อพบคำซ้ำ (Folder + Japanese + Kana ตรงกัน)</b></p>
    <label class="radio"><input type="radio" name="pol" value="skip" checked> เพิ่มเฉพาะคำใหม่ — ข้ามคำซ้ำ</label>
    <label class="radio"><input type="radio" name="pol" value="update"> เพิ่มคำใหม่ และอัปเดตคำเดิมด้วยข้อมูลจาก Excel (คงสถานะการเรียนไว้)</label>
    <label class="radio"><input type="radio" name="pol" value="keep"> เพิ่มทั้งหมด แม้ซ้ำ (จะมีคำซ้ำในระบบ)</label>
    <div class="foot"><button class="btn" data-r="0">ยกเลิก</button><button class="btn primary" data-r="1" ${parsed.rows.length?'':'disabled'}>ยืนยันนำเข้า ${parsed.rows.length} แถว</button></div>`, false);
  m.addEventListener('click', async e => {
    const b = e.target.closest('[data-r]'); if(!b) return;
    if(b.dataset.r === '0') return m.close();
    b.disabled = true; b.textContent = 'กำลังนำเข้า…';
    const policy = $('input[name=pol]:checked', m).value;
    const clean = parsed.rows.map(({_row,_dup,...r}) => r);
    try{
      const res = await DB.importWords(clean, policy);
      m.close(); await refreshAll();
      openModal(`<h3>นำเข้าเสร็จสิ้น ✅</h3><div class="sumgrid"><div><b style="color:var(--green)">${res.added}</b>เพิ่มใหม่</div>
        <div><b>${res.updated}</b>อัปเดต</div><div><b>${res.skipped}</b>ข้าม (ซ้ำ)</div><div><b style="color:var(--red)">${parsed.errors.length}</b>แถวผิดพลาด</div></div>
        ${newFolders.length ? `<p class="small">สร้างโฟลเดอร์ใหม่ ${newFolders.length} โฟลเดอร์</p>` : ''}
        <div class="foot"><button class="btn" data-x="w">ดูรายการคำศัพท์</button><button class="btn primary" data-x="s">เริ่มเรียน</button></div>`)
        .addEventListener('click', ev => { const x = ev.target.closest('[data-x]'); if(!x) return;
          ev.currentTarget.close(); S.deckBuilt = false; setView(x.dataset.x === 's' ? 'study' : 'words'); });
    }catch(err){ b.disabled = false; b.textContent = 'ลองอีกครั้ง'; toast('นำเข้าไม่สำเร็จ: ' + err.message, 'err'); }
  });
}

/* ============================================================
   EXPORT / BACKUP
   ============================================================ */
function renderBackup(){
  const cur = $('#expFolderSel').value;
  $('#expFolderSel').innerHTML = S.folders.map(f => `<option ${f.name===(cur||S.folder)?'selected':''}>${esc(f.name)}</option>`).join('');
}
const stamp = () => new Date().toISOString().slice(0,10);
function exportExcel(words, label){
  if(typeof XLSX === 'undefined'){ toast('โหลดไลบรารี SheetJS ไม่สำเร็จ — ต้องต่ออินเทอร์เน็ตหรือวางไฟล์ libs/xlsx.full.min.js','err'); return; }
  if(!words.length){ toast('ไม่มีคำศัพท์ให้ส่งออก','err'); return; }
  const H = ['Folder','Japanese','Kana Reading','Thai Meaning','Example Japanese','Example Thai','JLPT Level','Romaji','Notes'];
  const rows = words.map(w => [w.folder,w.japanese,w.kana,w.thai,w.exJp,w.exTh,w.level,w.romaji,w.notes]);
  const ws = XLSX.utils.aoa_to_sheet([H, ...rows]);
  ws['!cols'] = [18,18,18,26,34,34,10,18,26].map(wch => ({wch}));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Vocabulary');
  XLSX.writeFile(wb, `Japanese_Thai_Vocabulary_${label}_${stamp()}.xlsx`);
  toast(`ส่งออก ${words.length} คำแล้ว`, 'ok');
}
$('#expAll').onclick = () => exportExcel(S.words, 'All');
$('#expFolder').onclick = () => { const n = $('#expFolderSel').value; exportExcel(S.words.filter(w => w.folder === n), n.replace(/[^\p{L}\p{N}_-]+/gu,'_')); };
$('#expJson').onclick = async () => {
  try{ const data = await DB.exportJSON();
    download(`jp-th-flashcards-backup_${stamp()}.json`, new Blob([JSON.stringify(data,null,1)], {type:'application/json'}));
    toast(`สำรองข้อมูลแล้ว (${data.words.length} คำ, ${data.folders.length} โฟลเดอร์)`, 'ok');
  }catch(e){ toast('สำรองข้อมูลไม่สำเร็จ: ' + e.message, 'err'); }
};
$('#impJson').onclick = () => $('#jsonFile').click();
$('#jsonFile').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = ''; if(!file) return;
  let data;
  try{ data = JSON.parse(await file.text()); if(data.app !== 'jp-th-flashcards' || !Array.isArray(data.words) || !Array.isArray(data.folders)) throw 0; }
  catch(_){ toast('ไฟล์นี้ไม่ใช่ไฟล์สำรองของแอปนี้ (JSON ไม่ถูกต้อง)','err'); return; }
  const m = openModal(`<h3>กู้คืนจากไฟล์สำรอง</h3><p>ไฟล์: ${esc(file.name)}<br>มี <b>${data.words.length}</b> คำ, <b>${data.folders.length}</b> โฟลเดอร์ (สำรองเมื่อ ${fmtDate(data.exportedAt)})</p>
    <label class="radio"><input type="radio" name="jm" value="merge" checked> <b>รวมข้อมูล</b> — เพิ่มเฉพาะคำที่ยังไม่มี (ข้ามคำซ้ำ) ข้อมูลปัจจุบันไม่ถูกลบ</label>
    <label class="radio"><input type="radio" name="jm" value="replace"> <b style="color:var(--red)">เขียนทับทั้งหมด</b> — ลบข้อมูลปัจจุบัน (${S.words.length} คำ) แล้วใช้ข้อมูลจากไฟล์แทน</label>
    <div class="foot"><button class="btn" data-r="0">ยกเลิก</button><button class="btn primary" data-r="1">ยืนยัน</button></div>`, false);
  m.addEventListener('click', async ev => {
    const b = ev.target.closest('[data-r]'); if(!b) return;
    if(b.dataset.r === '0') return m.close();
    const mode = $('input[name=jm]:checked', m).value;
    if(mode === 'replace' && !(await confirmDialog('ยืนยันการเขียนทับ', `ข้อมูลปัจจุบัน ${S.words.length} คำจะถูกลบและแทนที่ — แน่ใจหรือไม่?`, 'เขียนทับ', true))) return;
    try{ const r = await DB.importJSON(data, mode); m.close(); S.deckBuilt = false; S.selected.clear(); await refreshAll();
      toast(mode === 'replace' ? `กู้คืนแล้ว ${r.added} คำ` : `รวมข้อมูลแล้ว: เพิ่ม ${r.added} คำ, ข้ามซ้ำ ${r.skipped} คำ`, 'ok');
    }catch(err){ toast('กู้คืนไม่สำเร็จ: ' + err.message, 'err'); }
  });
});

/* ============================================================
   INIT
   ============================================================ */
$$('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$('#menuBtn').onclick = () => { $('#sidebar').classList.toggle('open'); $('#scrim').classList.toggle('on'); };
$('#scrim').onclick = () => { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('on'); };

(async function init(){
  try{
    await DB.open();
    if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await reload(); renderFolders(); setView('dashboard');
  }catch(err){
    $('.main').innerHTML = `<div class="empty"><div class="big">!</div><p><b>เริ่มระบบไม่สำเร็จ</b><br>${esc(err.message)}</p>
      <p class="small">โหมดส่วนตัว (Private) ของบางเบราว์เซอร์ไม่รองรับ IndexedDB — ลองเปิดแบบปกติ หรือใช้ Chrome / Edge / Firefox / Safari รุ่นใหม่</p></div>`;
  }
})();
