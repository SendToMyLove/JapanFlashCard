/* ============================================================
   import.js — Excel import: parsing, validation, preview, commit
   Pure functions (no DOM) are in `ImportLogic` so they can be tested.
   The original Excel file is only read, never modified.
   ============================================================ */
const ImportLogic = (() => {
  // header text (normalised: lowercase, no spaces/_/-) -> internal field
  const ALIASES = {
    folder:['folder','โฟลเดอร์','หมวด','หมวดหมู่','category'],
    japanese:['japanese','japaneseword','word','kanji','คำศัพท์','ภาษาญี่ปุ่น','คำญี่ปุ่น'],
    kana:['kanareading','kana','reading','hiragana','furigana','คำอ่าน','คานะ'],
    thai:['thaimeaning','thai','meaning','ความหมาย','ความหมายไทย','ภาษาไทย'],
    exJp:['examplejapanese','examplejp','ประโยคตัวอย่างญี่ปุ่น','ตัวอย่างญี่ปุ่น'],
    exTh:['examplethai','exampleth','คำแปลประโยค','ประโยคตัวอย่างไทย','ตัวอย่างไทย'],
    level:['jlptlevel','jlpt','level','ระดับ'],
    romaji:['romaji','โรมาจิ'],
    notes:['notes','note','หมายเหตุ']
  };
  const LABELS = { folder:'Folder', japanese:'Japanese', kana:'Kana Reading', thai:'Thai Meaning', exJp:'Example Japanese',
    exTh:'Example Thai', level:'JLPT Level', romaji:'Romaji', notes:'Notes' };
  const REQUIRED = ['japanese','thai'];
  const normHeader = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s_\-.]+/g,'');
  const clean = v => String(v ?? '').normalize('NFC').replace(/\u00a0/g,' ').trim();

  /** Find the sheet named "Vocabulary" (case-insensitive). Returns name or null. */
  function findSheet(sheetNames){
    return sheetNames.find(n => n.trim().toLowerCase() === 'vocabulary') || null;
  }

  /** headerRow: array of cell values. Returns {map:{field:colIndex}, missing:[field], unknown:[header]} */
  function mapHeaders(headerRow){
    const map = {}, unknown = [];
    headerRow.forEach((h, i) => {
      const n = normHeader(h); if(!n) return;
      const field = Object.keys(ALIASES).find(f => ALIASES[f].some(a => normHeader(a) === n));
      if(field && !(field in map)) map[field] = i; else if(!field) unknown.push(String(h));
    });
    return { map, missing: REQUIRED.filter(f => !(f in map)), unknown };
  }

  /**
   * matrix: array of rows (arrays), first row = header.
   * Returns {rows:[valid word objects + _row], errors:[{row,reason}], total}
   * Excel row numbers are 1-based and include the header row.
   */
  function parseMatrix(matrix){
    if(!matrix.length) return { fatal:'ชีตว่างเปล่า ไม่มีแถวข้อมูล' };
    const { map, missing, unknown } = mapHeaders(matrix[0]);
    if(missing.length){
      const found = matrix[0].map(h => clean(h)).filter(Boolean).join(', ') || '(ไม่พบชื่อคอลัมน์)';
      return { fatal:`ไม่พบคอลัมน์ที่จำเป็น: ${missing.map(f => LABELS[f]).join(', ')}\nคอลัมน์ที่พบในแถวแรก: ${found}` };
    }
    const rows = [], errors = [];
    let total = 0;
    for(let r = 1; r < matrix.length; r++){
      const line = matrix[r] || [];
      if(line.every(c => clean(c) === '')) continue;          // blank row: ignore silently
      total++;
      const get = f => (f in map) ? clean(line[map[f]]) : '';
      const w = { folder: get('folder') || UNCAT_NAME, japanese:get('japanese'), kana:get('kana'), thai:get('thai'),
        exJp:get('exJp'), exTh:get('exTh'), level:get('level'), romaji:get('romaji'), notes:get('notes'), _row:r+1 };
      const miss = [];
      if(!w.japanese) miss.push('Japanese'); if(!w.thai) miss.push('Thai Meaning');
      if(miss.length) errors.push({ row:r+1, reason:`ช่อง ${miss.join(' และ ')} ว่าง` });
      else rows.push(w);
    }
    return { rows, errors, total, unknown };
  }
  const UNCAT_NAME = 'Uncategorized';

  /** Mark each valid row as new / duplicate (vs DB or earlier in the same file). */
  function classify(rows, existingKeys, keyFn){
    const seen = new Set(existingKeys);
    let fresh = 0, dup = 0;
    rows.forEach(r => {
      const k = keyFn(r.folder, r.japanese, r.kana);
      r._dup = seen.has(k);
      if(r._dup) dup++; else { fresh++; seen.add(k); }
    });
    return { fresh, dup };
  }
  return { mapHeaders, parseMatrix, classify, findSheet, LABELS };
})();
if(typeof module !== 'undefined') module.exports = ImportLogic;

/* ------------------------------------------------------------
   Browser part: read file with SheetJS, then drive the dialog
   ------------------------------------------------------------ */
const Importer = {
  /** Read an .xlsx/.xls File → {fileName, parsed} or throws Error with Thai message. */
  async readFile(file){
    if(typeof XLSX === 'undefined')
      throw new Error('โหลดไลบรารี SheetJS ไม่สำเร็จ — ต้องต่ออินเทอร์เน็ตครั้งแรก หรือวางไฟล์ libs/xlsx.full.min.js (ดู README)');
    if(!/\.(xlsx|xls)$/i.test(file.name)) throw new Error('รองรับเฉพาะไฟล์ .xlsx และ .xls');
    let wb;
    try{ wb = XLSX.read(await file.arrayBuffer(), { type:'array' }); }
    catch(e){ throw new Error('อ่านไฟล์ Excel ไม่ได้ — ไฟล์อาจเสียหรือมีรหัสผ่าน'); }
    const name = ImportLogic.findSheet(wb.SheetNames);
    if(!name) throw new Error(`ไม่พบชีตชื่อ "Vocabulary" ในไฟล์นี้\nชีตที่พบ: ${wb.SheetNames.join(', ') || '(ไม่มี)'}`);
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[name], { header:1, defval:'', raw:false, blankrows:false });
    const parsed = ImportLogic.parseMatrix(matrix);
    if(parsed.fatal) throw new Error(parsed.fatal);
    return { fileName:file.name, parsed };
  }
};
