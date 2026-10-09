/* ============================================================
   db.js — IndexedDB storage layer
   Stores:  folders (key: name) | words (key: id, auto) | meta
   ============================================================ */
const UNCAT = 'Uncategorized';
const DEFAULT_FOLDERS = ['ชีวิตประจำวัน','โรงงาน (Production)','เครื่องมือและอุปกรณ์','Quality Control',
  'JLPT N5','JLPT N4','JLPT N3','JLPT N2','JLPT N1'];

const DB = (() => {
  const NAME = 'jp_th_flashcards', VERSION = 1;
  let db = null;

  /** Normalise text used for duplicate keys (trim, NFKC, collapse spaces, lowercase). */
  function norm(s){ return String(s ?? '').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase(); }
  function dupKey(folder, jp, kana){ return [norm(folder), norm(jp), norm(kana)].join('|'); }

  function open(){
    return new Promise((resolve, reject) => {
      if(!('indexedDB' in window)) return reject(new Error('เบราว์เซอร์นี้ไม่รองรับ IndexedDB'));
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if(!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', { keyPath:'name' });
        if(!d.objectStoreNames.contains('words')){
          const w = d.createObjectStore('words', { keyPath:'id', autoIncrement:true });
          w.createIndex('folder','folder',{unique:false});
        }
        if(!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath:'key' });
      };
      req.onsuccess = async () => { db = req.result; try{ await seed(); resolve(db); }catch(e){ reject(e); } };
      req.onerror = () => reject(req.error || new Error('เปิดฐานข้อมูลไม่สำเร็จ'));
      req.onblocked = () => reject(new Error('ฐานข้อมูลถูกบล็อก กรุณาปิดแท็บอื่นของเว็บนี้แล้วลองใหม่'));
    });
  }

  /** Run a request-producing function inside a transaction; resolves when the transaction completes. */
  function tx(stores, mode, fn){
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('ธุรกรรมฐานข้อมูลถูกยกเลิก'));
      Promise.resolve(fn(t)).then(r => { result = r; }).catch(e => { try{ t.abort(); }catch(_){} reject(e); });
    });
  }
  const rq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  /** Create default (empty) folders on first run only. No vocabulary is ever seeded. */
  async function seed(){
    const seeded = await tx(['meta'],'readonly', t => rq(t.objectStore('meta').get('seeded')));
    if(seeded) return;
    await tx(['folders','meta'],'readwrite', t => {
      const f = t.objectStore('folders');
      [UNCAT, ...DEFAULT_FOLDERS].forEach(n => f.put({ name:n, createdAt:Date.now() }));
      t.objectStore('meta').put({ key:'seeded', value:true });
    });
  }

  const getFolders = () => tx(['folders'],'readonly', t => rq(t.objectStore('folders').getAll()));
  const getWords = () => tx(['words'],'readonly', t => rq(t.objectStore('words').getAll()));

  async function addFolder(name){
    name = name.trim();
    if(!name) throw new Error('กรุณาระบุชื่อโฟลเดอร์');
    const all = await getFolders();
    if(all.some(f => norm(f.name) === norm(name))) throw new Error('มีโฟลเดอร์ชื่อนี้อยู่แล้ว');
    await tx(['folders'],'readwrite', t => t.objectStore('folders').put({ name, createdAt:Date.now() }));
    return name;
  }
  async function renameFolder(oldName, newName){
    newName = newName.trim();
    if(oldName === UNCAT) throw new Error('ไม่สามารถเปลี่ยนชื่อโฟลเดอร์ Uncategorized ได้');
    if(!newName) throw new Error('กรุณาระบุชื่อโฟลเดอร์');
    const all = await getFolders();
    if(all.some(f => f.name !== oldName && norm(f.name) === norm(newName))) throw new Error('มีโฟลเดอร์ชื่อนี้อยู่แล้ว');
    await tx(['folders','words'],'readwrite', async t => {
      const ws = await rq(t.objectStore('words').index('folder').getAll(oldName));
      ws.forEach(w => { w.folder = newName; t.objectStore('words').put(w); });
      t.objectStore('folders').delete(oldName);
      t.objectStore('folders').put({ name:newName, createdAt:Date.now() });
    });
  }
  /** mode: 'move' (to Uncategorized) | 'delete' (delete words too) */
  async function deleteFolder(name, mode){
    if(name === UNCAT) throw new Error('ไม่สามารถลบโฟลเดอร์ Uncategorized ได้');
    await tx(['folders','words'],'readwrite', async t => {
      const ws = await rq(t.objectStore('words').index('folder').getAll(name));
      ws.forEach(w => {
        if(mode === 'delete') t.objectStore('words').delete(w.id);
        else { w.folder = UNCAT; t.objectStore('words').put(w); }
      });
      t.objectStore('folders').delete(name);
    });
  }

  function blankWord(o){
    return Object.assign({ folder:UNCAT, japanese:'', kana:'', thai:'', exJp:'', exTh:'', level:'', romaji:'', notes:'',
      status:'new', reviewCount:0, lastReview:null, createdAt:Date.now() }, o);
  }
  async function ensureFolder(t, name){
    const s = t.objectStore('folders');
    if(!(await rq(s.get(name)))) s.put({ name, createdAt:Date.now() });
  }
  async function saveWord(w){
    return tx(['words','folders'],'readwrite', async t => {
      await ensureFolder(t, w.folder);
      return rq(t.objectStore('words').put(w));
    });
  }
  async function deleteWords(ids){
    await tx(['words'],'readwrite', t => ids.forEach(id => t.objectStore('words').delete(id)));
  }
  async function moveWords(ids, folder){
    await tx(['words','folders'],'readwrite', async t => {
      await ensureFolder(t, folder);
      for(const id of ids){
        const w = await rq(t.objectStore('words').get(id));
        if(w){ w.folder = folder; t.objectStore('words').put(w); }
      }
    });
  }

  /**
   * Bulk import. rows: [{folder,japanese,kana,thai,exJp,exTh,level,romaji,notes}]
   * policy: 'skip' (add new only) | 'update' (add new + update existing) | 'keep' (add everything, allow duplicates)
   * Returns {added, updated, skipped}
   */
  async function importWords(rows, policy){
    const existing = await getWords();
    const index = new Map(existing.map(w => [dupKey(w.folder, w.japanese, w.kana), w]));
    const res = { added:0, updated:0, skipped:0 };
    await tx(['words','folders'],'readwrite', async t => {
      const ws = t.objectStore('words');
      const folders = new Set((await rq(t.objectStore('folders').getAllKeys())));
      for(const r of rows){
        if(!folders.has(r.folder)){ t.objectStore('folders').put({ name:r.folder, createdAt:Date.now() }); folders.add(r.folder); }
        const k = dupKey(r.folder, r.japanese, r.kana);
        const hit = index.get(k);
        if(hit && policy !== 'keep'){
          if(policy === 'update'){
            // overwrite content fields, keep learning progress (status, counts, dates)
            Object.assign(hit, { japanese:r.japanese, kana:r.kana, thai:r.thai, exJp:r.exJp, exTh:r.exTh,
              level:r.level, romaji:r.romaji, notes:r.notes });
            ws.put(hit); res.updated++;
          } else res.skipped++;
        } else {
          const w = blankWord(r);
          const id = await rq(ws.add(w)); w.id = id; index.set(k, w); res.added++;
        }
      }
    });
    return res;
  }

  async function exportJSON(){
    return { app:'jp-th-flashcards', version:1, exportedAt:new Date().toISOString(),
      folders: await getFolders(), words: await getWords() };
  }
  /** mode: 'replace' | 'merge' */
  async function importJSON(data, mode){
    if(!data || data.app !== 'jp-th-flashcards' || !Array.isArray(data.words) || !Array.isArray(data.folders))
      throw new Error('ไฟล์ JSON ไม่ใช่ไฟล์สำรองของแอปนี้');
    const res = { added:0, skipped:0, folders:0 };
    if(mode === 'replace'){
      await tx(['words','folders'],'readwrite', t => {
        t.objectStore('words').clear(); t.objectStore('folders').clear();
        data.folders.forEach(f => t.objectStore('folders').put({ name:f.name, createdAt:f.createdAt||Date.now() }));
        t.objectStore('folders').put({ name:UNCAT, createdAt:Date.now() });
        data.words.forEach(w => { const c = {...w}; delete c.id; t.objectStore('words').add(blankWord(c)); res.added++; });
      });
      res.folders = data.folders.length;
    } else {
      const existing = await getWords();
      const seen = new Set(existing.map(w => dupKey(w.folder, w.japanese, w.kana)));
      await tx(['words','folders'],'readwrite', t => {
        data.folders.forEach(f => t.objectStore('folders').put({ name:f.name, createdAt:f.createdAt||Date.now() }));
        data.words.forEach(w => {
          const k = dupKey(w.folder, w.japanese, w.kana);
          if(seen.has(k)){ res.skipped++; return; }
          seen.add(k); const c = {...w}; delete c.id; t.objectStore('words').add(blankWord(c)); res.added++;
        });
      });
      res.folders = data.folders.length;
    }
    return res;
  }

  return { open, norm, dupKey, getFolders, getWords, addFolder, renameFolder, deleteFolder, blankWord,
    saveWord, deleteWords, moveWords, importWords, exportJSON, importJSON };
})();
