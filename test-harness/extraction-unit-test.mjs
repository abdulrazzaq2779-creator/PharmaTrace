/**
 * Extraction unit test — verifies the three reported parsing bugs:
 *
 * 1. "(XP. 03/2026" (opening paren eaten as E by repairLabelConfusions) is
 *    extracted as expiry_date and lands in FIELDS (strict hit), not candidates.
 *
 * 2. "B.No G652046 MFG 04/2026 EXP 03/2028" multi-field line → all three
 *    fields populate; batch/mfg/exp are in fields (strict), NOT in candidates.
 *
 * 3. placeHit fix: a strict+high+non-ambiguous hit must go to fields, not
 *    candidates.  Before the fix, the reason calculation produced 'fuzzy' for
 *    strict hits and then pushed them to candidates anyway.
 *
 * Run with:  node test-harness/extraction-unit-test.mjs
 */

// --------------------------------------------------------------------------
// Minimal in-process re-implementation of the two functions under test
// (mirrors the actual TS source logic so we can run without bundling).
// --------------------------------------------------------------------------

// -- grounding.ts --
function normalizePackText(text) {
  return text.toUpperCase().replace(/\s+/g, ' ').trim();
}

function repairLabelConfusions(text) {
  let out = normalizePackText(text);
  // Opening punctuation often eaten as the leading E of EXP / EXPIRY.
  out = out.replace(/[(\[{!|](?=X?P)/g, 'E');
  out = out.replace(/\b([A-Z01]{2,12})\b/g, token => {
    if (/\d{2,}/.test(token) && /[A-Z]/.test(token) === false) return token;
    const letters = token.replace(/[01]/g, ch => (ch === '0' ? 'O' : 'I'));
    if (/^[A-Z]+$/.test(letters) && letters.length <= 12) return letters;
    return token;
  });
  return out.replace(/\s+/g, ' ').trim();
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i-1] === b[j-1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[n];
}

// -- extract.ts helpers --
const MONTHS = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',SEPT:'09',OCT:'10',NOV:'11',DEC:'12' };
const MONTH_RE = '(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)';
const DATE_TOKEN = `(\\d{2}\\s*[/-]\\s*\\d{4}|${MONTH_RE}\\.?\\s+\\d{4}|\\d{2}\\s*[/-]\\s*\\d{2})`;

function normalizeDate(raw) {
  const text = raw.toUpperCase().replace(/[._]/g, ' ').trim();
  const monthName = text.match(new RegExp(`(${MONTH_RE})[\\s/-]*(\\d{2,4})`));
  if (monthName) {
    const mm = MONTHS[monthName[1] === 'SEPT' ? 'SEP' : monthName[1]];
    const year = monthName[2];
    return `${mm}/${year.length === 2 ? `20${year}` : year}`;
  }
  const numeric = text.match(/(\d{2})\s*[-/]\s*(\d{2,4})/);
  if (numeric) {
    const [, a, b] = numeric;
    if (b.length === 4 && Number(b) > 1900) return `${a}/${b}`;
    if (b.length === 2) return `${a}/20${b}`;
    return `${a}/${b}`;
  }
  return text;
}

function tokenFuzzy(token, label) {
  const a = token.replace(/[^A-Z]/g, '');
  const b = label.replace(/[^A-Z]/g, '');
  if (!a || a.length < 2) return false;
  if (a === b) return true;
  if (b.startsWith(a) && a.length >= b.length - 1) return true;
  return editDistance(a, b) <= 1;
}

function isExpLabel(token) {
  const t = token.replace(/[^A-Z]/g, '');
  return ['EXP','EXPIRY','EXPDATE','USEBY','BESTBEFORE'].some(l => tokenFuzzy(token, l)) || /^E?XP$/.test(t);
}

function isMfgLabel(token) {
  return ['MFG','MFD','MFGDATE','MFDDATE','MFGD'].some(l => tokenFuzzy(token, l));
}

function searchLabeledDate(lines, kind) {
  for (const line of lines) {
    const repaired = repairLabelConfusions(line.text);
    const re = new RegExp(`\\b([A-Z]{2,12})\\.?\\s*[:.\\-]*\\s*${DATE_TOKEN}`, 'g');
    let m;
    while ((m = re.exec(repaired))) {
      const label = m[1];
      const ok = kind === 'exp' ? isExpLabel(label) : isMfgLabel(label);
      if (!ok) continue;
      const compact = label.replace(/[^A-Z]/g, '');
      const fuzzy = kind === 'exp'
        ? !['EXP','EXPIRY','EXPDATE'].includes(compact)
        : !['MFG','MFD','MFGDATE','MFDDATE','MFGD'].includes(compact);
      return {
        quality: fuzzy ? 'fuzzy' : 'strict',
        field: {
          value: normalizeDate(m[2]),
          confidence: fuzzy || line.confidence === 'low' ? 'low' : 'high',
          origin: 'image',
          matchQuality: fuzzy ? 'fuzzy' : 'strict',
        },
      };
    }
  }
  return null;
}

function extractBatch(lines) {
  for (const line of lines) {
    const repaired = repairLabelConfusions(line.text);
    const hit = repaired.match(/\b(B\.?\s*NO|BATCH(?:\s*NO)?|LOT(?:\s*NO)?)\b\s*[:.\-]*\s*([A-Z0-9][A-Z0-9-]{4,11})\b/);
    if (!hit) continue;
    const value = hit[2].toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (value.length < 5 || value.length > 12) continue;
    const lab = hit[1].replace(/[^A-Z]/g, '');
    const fuzzy = !['BATCH','BATCHNO','BNO','LOT','LOTNO'].includes(lab);
    return {
      quality: fuzzy ? 'fuzzy' : 'strict',
      field: { value, confidence: fuzzy || line.confidence === 'low' ? 'low' : 'high', origin: 'image', matchQuality: fuzzy ? 'fuzzy' : 'strict' },
    };
  }
  return null;
}

// placeHit (FIXED version from extract.ts)
function placeHit(fields, candidates, key, hit) {
  if (!hit) return;
  if (hit.quality === 'strict' && hit.field.confidence !== 'low' && !hit.field.ambiguous) {
    fields[key] = hit.field;
    return;
  }
  const reason = hit.field.ambiguous
    ? 'ambiguous-digit'
    : hit.quality === 'unlabeled' ? 'unlabeled'
    : hit.quality === 'fuzzy' ? 'fuzzy'
    : 'low-confidence';
  candidates.push({ key, value: hit.field.value, reason });
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// ──────────────────────────────────────────────────────────────────────────
console.log('\n[repairLabelConfusions — sideways-strip OCR noise]');
{
  // The specific string from the bug report
  const repaired = repairLabelConfusions('(XP. 03/2026 INCL, OF ALL TAXES');
  check('( before XP becomes E', repaired.startsWith('EXP'), `got: "${repaired}"`);
  check('date still present', repaired.includes('03/2026'), `got: "${repaired}"`);

  const r2 = repairLabelConfusions('[XP 04/2026');
  check('[ before XP becomes E', r2.startsWith('EXP'), `got: "${r2}"`);

  const r3 = repairLabelConfusions('!XP03/2026');
  check('! before XP becomes E', r3.startsWith('EXP'), `got: "${r3}"`);
}

// ──────────────────────────────────────────────────────────────────────────
console.log('\n[searchLabeledDate with OCR-noisy EXP labels]');
{
  const noisy = [{ text: '(XP. 03/2026 INCL, OF ALL TAXES', confidence: 'medium' }];
  const hit = searchLabeledDate(noisy, 'exp');
  check('(XP. → expiry found', hit !== null, 'hit was null');
  check('value normalised to MM/YYYY', hit?.field.value === '03/2026', `got: ${hit?.field.value}`);
  check('quality is strict', hit?.quality === 'strict', `got: ${hit?.quality}`);
  check('confidence is high', hit?.field.confidence === 'high', `got: ${hit?.field.confidence}`);
}

// ──────────────────────────────────────────────────────────────────────────
console.log('\n[placeHit — strict+high → fields, NOT candidates]');
{
  const strictHighHit = {
    quality: 'strict',
    field: { value: '03/2026', confidence: 'high', origin: 'image' },
  };
  const fields = { expiry_date: null };
  const candidates = [];
  placeHit(fields, candidates, 'expiry_date', strictHighHit);
  check('goes to fields', fields.expiry_date?.value === '03/2026', `fields.expiry_date=${JSON.stringify(fields.expiry_date)}`);
  check('NOT pushed to candidates', candidates.length === 0, `candidates=${JSON.stringify(candidates)}`);
}

console.log('\n[placeHit — fuzzy → candidates]');
{
  const fuzzyHit = {
    quality: 'fuzzy',
    field: { value: '03/2026', confidence: 'high', origin: 'image' },
  };
  const fields = { expiry_date: null };
  const candidates = [];
  placeHit(fields, candidates, 'expiry_date', fuzzyHit);
  check('stays null in fields', fields.expiry_date === null);
  check('pushed to candidates', candidates.length === 1 && candidates[0].reason === 'fuzzy', `candidates=${JSON.stringify(candidates)}`);
}

console.log('\n[placeHit — strict+low-confidence → candidates with correct reason]');
{
  const lowConfHit = {
    quality: 'strict',
    field: { value: '03/2026', confidence: 'low', origin: 'image' },
  };
  const fields = { expiry_date: null };
  const candidates = [];
  placeHit(fields, candidates, 'expiry_date', lowConfHit);
  check('stays null in fields', fields.expiry_date === null);
  check('reason is low-confidence (not fuzzy)', candidates[0]?.reason === 'low-confidence', `got: ${candidates[0]?.reason}`);
}

// ──────────────────────────────────────────────────────────────────────────
console.log('\n[multi-field line: batch + mfg + exp on one line]');
{
  const lines = [{ text: 'B.No G652046 MFG 04/2026 EXP 03/2028', confidence: 'medium' }];
  const batchHit  = extractBatch(lines);
  const mfgHit    = searchLabeledDate(lines, 'mfg');
  const expHit    = searchLabeledDate(lines, 'exp');

  check('batch extracted', batchHit?.field.value === 'G652046', `got: ${batchHit?.field.value}`);
  check('batch quality strict', batchHit?.quality === 'strict', `got: ${batchHit?.quality}`);

  check('mfg extracted', mfgHit?.field.value === '04/2026', `got: ${mfgHit?.field.value}`);
  check('mfg quality strict', mfgHit?.quality === 'strict', `got: ${mfgHit?.quality}`);

  check('exp extracted', expHit?.field.value === '03/2028', `got: ${expHit?.field.value}`);
  check('exp quality strict', expHit?.quality === 'strict', `got: ${expHit?.quality}`);

  // When all three are strict+high, placeHit puts them all in fields.
  const fields = { batch_no: null, mfg_date: null, expiry_date: null };
  const candidates = [];
  placeHit(fields, candidates, 'batch_no', batchHit);
  placeHit(fields, candidates, 'mfg_date', mfgHit);
  placeHit(fields, candidates, 'expiry_date', expHit);

  check('batch in fields', fields.batch_no?.value === 'G652046');
  check('mfg in fields', fields.mfg_date?.value === '04/2026');
  check('exp in fields', fields.expiry_date?.value === '03/2028');
  check('no candidates (all strict+high)', candidates.length === 0, `candidates=${JSON.stringify(candidates)}`);
}

// ──────────────────────────────────────────────────────────────────────────
console.log('\n[collectedDetails counting: fieldCountsAsCollected]');
{
  // Replicate the function from types/index.ts
  function fieldCountsAsCollected(field) {
    if (!field?.value) return false;
    if (field.confirmedByUser || field.origin === 'user') return true;
    if (field.grounded === false) return false;
    return field.confidence === 'high' || field.confidence === 'medium';
  }

  check('null → not collected', !fieldCountsAsCollected(null));
  check('high+grounded → collected', fieldCountsAsCollected({ value: 'X', confidence: 'high', origin: 'image', grounded: true }));
  check('medium+grounded → collected', fieldCountsAsCollected({ value: 'X', confidence: 'medium', origin: 'image', grounded: true }));
  check('low → not collected (goes to confirm)', !fieldCountsAsCollected({ value: 'X', confidence: 'low', origin: 'image' }));
  check('confirmedByUser+low → collected', fieldCountsAsCollected({ value: 'X', confidence: 'low', origin: 'image', confirmedByUser: true }));
  check('user-typed → collected', fieldCountsAsCollected({ value: 'X', confidence: 'low', origin: 'user' }));
  check('grounded=false → not collected', !fieldCountsAsCollected({ value: 'X', confidence: 'high', origin: 'image', grounded: false }));
}

// ──────────────────────────────────────────────────────────────────────────
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail > 0 ? 1 : 0);
