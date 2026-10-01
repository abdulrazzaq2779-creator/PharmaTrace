import type {
  BBox,
  DecodedCode,
  ExtractedData,
  ExtractedFields,
  ExtractionField,
  FieldCandidate,
  FieldKey,
  MatchQuality,
  TextLine,
} from '../types';
import productsJson from '../data/products.json';
import {
  editDistance,
  findSourceLine,
  fuzzyContains,
  hasDollarPrice,
  looksIndianPack,
  repairLabelConfusions,
} from '../utils/grounding';

export type ManufacturerCatalogEntry = {
  manufacturer: string;
  products: Array<{ name: string; strengths: string[]; dosageForms: string[] }>;
};

/** The reference catalog for the company-product consistency check (STEP 5). */
export const productCatalog: ManufacturerCatalogEntry[] = productsJson;

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', SEPT: '09', OCT: '10', NOV: '11', DEC: '12',
};

const MONTH_RE = '(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)';

// ---------------------------------------------------------------------------
// Medicine keyword detection (replaces hard pack-type fail)
// ---------------------------------------------------------------------------

export const MEDICINE_KEYWORDS: RegExp[] = [
  /\btablets?\b/i,
  /\bcapsules?\b/i,
  /\bmg\b|\bmcg\b/i,
  /\bI\.?P\.?\b|\bUSP\b|\bBP\b/i,
  /\bRx\b/i,
  /\bschedule\b/i,
  /\bmanufactured\b|\bmfd\b|\bmfg\b/i,
  /\bmarketed\b|\bmkt\b/i,
  /\bbatch\b|\bb\.?\s*no\b|\blot\b/i,
  /\bexp\b|\bexpiry\b|\bmfg\.?\s*date\b/i,
  /\bm\.?r\.?p\b|\bmrp\b/i,
  /\bcomposition\b/i,
];

/** Count distinct medicine keywords present in the text lines. */
export function countMedicineKeywords(lines: TextLine[]): number {
  const text = lines.map(l => l.text).join('\n');
  return MEDICINE_KEYWORDS.reduce((count, re) => (re.test(text) ? count + 1 : count), 0);
}

/**
 * Join EVERY recognized line from ALL passes, bands, crops and rotations into
 * one string. Not just the lines that matched a date/batch regex — the whole
 * recognized text is the evidence the verifier searches.
 */
export function joinRawText(lines: Array<{ text: string }>): string {
  return lines.map(l => l.text).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Remove OCR junk and collapse whitespace. */
export function cleanLine(text: string): string {
  return text.replace(/[|_~^`]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function field(
  value: string,
  confidence: ExtractionField['confidence'],
  line: TextLine,
  matchedText: string,
  extras?: Partial<ExtractionField>
): ExtractionField {
  return {
    value,
    confidence,
    origin: 'image',
    grounded: true,
    matchQuality: extras?.matchQuality ?? 'strict',
    provenance: {
      bbox: line.bbox,
      matchedText: cleanLine(matchedText),
      runLabel: line.runLabel,
    },
    ...extras,
  };
}

function matchLine(lines: TextLine[], re: RegExp): { line: TextLine; match: RegExpMatchArray } | null {
  for (const line of lines) {
    const match = line.text.match(re);
    if (match) return { line, match };
  }
  return null;
}

/** Normalize month-name or numeric dates to "MM/YYYY". Tolerates OCR noise. */
export function normalizeDate(raw: string): string {
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
    if (a.length === 4) return `${b}/${a}`;
    return `${a}/${b}`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Field extraction — tolerant regexes; null when nothing matched
// ---------------------------------------------------------------------------

const DATE_TOKEN = `(\\d{2}\\s*[/-]\\s*\\d{4}|${MONTH_RE}\\.?\\s+\\d{4}|\\d{2}\\s*[/-]\\s*\\d{2})`;

function tokenFuzzy(token: string, label: string): boolean {
  const a = token.replace(/[^A-Z]/g, '');
  const b = label.replace(/[^A-Z]/g, '');
  if (!a || a.length < 2) return false;
  if (a === b) return true;
  if (b.startsWith(a) && a.length >= b.length - 1) return true;
  return editDistance(a, b) <= 1;
}

function isExpLabel(token: string): boolean {
  const t = token.replace(/[^A-Z]/g, '');
  return ['EXP', 'EXPIRY', 'EXPDATE', 'USEBY', 'BESTBEFORE'].some(l => tokenFuzzy(token, l)) || /^E?XP$/.test(t);
}

function isMfgLabel(token: string): boolean {
  return ['MFG', 'MFD', 'MFGDATE', 'MFDDATE', 'MFGD'].some(l => tokenFuzzy(token, l));
}

function dateAmbiguous(raw: string): string | undefined {
  if (/[68]/.test(raw) && /[OQGDSBilI|]/.test(raw)) return 'A digit may be 6 or 8 — please confirm.';
  return undefined;
}

interface LabeledHit {
  field: ExtractionField;
  quality: MatchQuality;
}

function searchLabeledDate(lines: TextLine[], kind: 'exp' | 'mfg'): LabeledHit | null {
  for (const line of lines) {
    const repaired = repairLabelConfusions(line.text);
    const re = new RegExp(`\\b([A-Z]{2,12})\\.?\\s*[:.\\-]*\\s*${DATE_TOKEN}`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(repaired))) {
      const label = m[1];
      const ok = kind === 'exp' ? isExpLabel(label) : isMfgLabel(label);
      if (!ok) continue;
      const compact = label.replace(/[^A-Z]/g, '');
      const fuzzy = kind === 'exp' ? !['EXP', 'EXPIRY', 'EXPDATE'].includes(compact) : !['MFG', 'MFD', 'MFGDATE', 'MFDDATE', 'MFGD'].includes(compact);
      const hint = dateAmbiguous(m[0] + line.text);
      return {
        quality: fuzzy ? 'fuzzy' : 'strict',
        field: field(normalizeDate(m[2]), fuzzy || line.confidence === 'low' ? 'low' : 'high', line, m[0], {
          matchQuality: fuzzy ? 'fuzzy' : 'strict',
          ambiguous: Boolean(hint),
          ambiguousHint: hint,
        }),
      };
    }
  }
  return null;
}

function extractBatch(lines: TextLine[]): LabeledHit | null {
  for (const line of lines) {
    const repaired = repairLabelConfusions(line.text);
    const hit = repaired.match(/\b(B\.?\s*NO|BATCH(?:\s*NO)?|LOT(?:\s*NO)?)\b\s*[:.\-]*\s*([A-Z0-9][A-Z0-9-]{4,11})\b/);
    if (!hit) continue;
    const value = hit[2].toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (value.length < 5 || value.length > 12) continue;
    const lab = hit[1].replace(/[^A-Z]/g, '');
    const fuzzy = !['BATCH', 'BATCHNO', 'BNO', 'LOT', 'LOTNO'].includes(lab);
    return {
      quality: fuzzy ? 'fuzzy' : 'strict',
      field: field(value, fuzzy || line.confidence === 'low' ? 'low' : 'high', line, hit[0], {
        matchQuality: fuzzy ? 'fuzzy' : 'strict',
      }),
    };
  }
  return null;
}

function extractMfgDate(lines: TextLine[]): LabeledHit | null {
  return searchLabeledDate(lines, 'mfg');
}

function extractExpiry(lines: TextLine[]): LabeledHit | null {
  return searchLabeledDate(lines, 'exp');
}

function extractMrp(lines: TextLine[]): LabeledHit | null {
  for (const line of lines) {
    const repaired = repairLabelConfusions(line.text);
    const hit = repaired.match(/\b(M\.?R\.?P)\.?\s*[:.\-]*\s*(?:RS\.?|INR|₹)?\s*(\d+[.,]\d{1,2})\b/);
    if (!hit) continue;
    const amount = hit[2].replace(',', '.');
    const fuzzy = hit[1].replace(/[^A-Z]/g, '') !== 'MRP';
    return {
      quality: fuzzy ? 'fuzzy' : 'strict',
      field: field(`₹${amount}`, fuzzy || line.confidence === 'low' ? 'low' : 'high', line, hit[0], {
        matchQuality: fuzzy ? 'fuzzy' : 'strict',
      }),
    };
  }
  return null;
}

function unlabeledDates(lines: TextLine[]): { mfg: LabeledHit; exp: LabeledHit } | null {
  const found: Array<{ value: string; line: TextLine; raw: string }> = [];
  for (const line of lines) {
    const repaired = repairLabelConfusions(line.text);
    const re = new RegExp(DATE_TOKEN, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(repaired))) {
      const value = normalizeDate(m[1] ?? m[0]);
      if (!/^\d{2}\/\d{4}$/.test(value)) continue;
      if (!found.some(f => f.value === value)) found.push({ value, line, raw: m[0] });
    }
  }
  if (found.length < 2) return null;
  const sorted = [...found].sort((a, b) => {
    const [am, ay] = a.value.split('/').map(Number);
    const [bm, by] = b.value.split('/').map(Number);
    return ay * 12 + am - (by * 12 + bm);
  });
  const earlier = sorted[0];
  const later = sorted[sorted.length - 1];
  if (earlier.value === later.value) return null;
  const hint = dateAmbiguous(earlier.raw + later.raw);
  return {
    mfg: {
      quality: 'unlabeled',
      field: field(earlier.value, 'low', earlier.line, earlier.raw, {
        matchQuality: 'unlabeled',
        ambiguous: Boolean(hint),
        ambiguousHint: hint,
      }),
    },
    exp: {
      quality: 'unlabeled',
      field: field(later.value, 'low', later.line, later.raw, {
        matchQuality: 'unlabeled',
        ambiguous: Boolean(hint),
        ambiguousHint: hint,
      }),
    },
  };
}

function hitToCandidate(key: FieldKey, hit: LabeledHit, reason: FieldCandidate['reason']): FieldCandidate {
  return {
    key,
    value: hit.field.value,
    matchedText: hit.field.provenance?.matchedText ?? hit.field.value,
    bbox: hit.field.provenance?.bbox,
    confidence: hit.field.confidence,
    reason,
    ambiguousHint: hit.field.ambiguousHint,
  };
}

function placeHit(
  fields: ExtractedFields,
  candidates: FieldCandidate[],
  key: FieldKey,
  hit: LabeledHit | null
): void {
  if (!hit) return;

  // A strict, high-confidence, unambiguous hit goes directly into fields — no confirm needed.
  if (hit.quality === 'strict' && hit.field.confidence !== 'low' && !hit.field.ambiguous) {
    console.log(`[placeHit] ${key} → fields (strict/high)`, hit.field.value);
    fields[key] = hit.field;
    return;
  }

  // Determine the correct reason for the confirm step.
  const reason: FieldCandidate['reason'] = hit.field.ambiguous
    ? 'ambiguous-digit'
    : hit.quality === 'unlabeled'
      ? 'unlabeled'
      : hit.quality === 'fuzzy'
        ? 'fuzzy'
        : 'low-confidence'; // strict but low confidence

  console.log(`[placeHit] ${key} → candidates (${reason})`, hit.field.value);
  candidates.push(hitToCandidate(key, hit, reason));
}

function extractLicense(lines: TextLine[]): ExtractionField | null {
  // Mfg.?\s*Lic.?\s*No.?\s*[:.\-]?\s*([A-Z0-9\/\-\s]+)
  const hit = matchLine(
    lines,
    /\b(?:Mfg\.?\s*Lic\.?\s*No\.?|M\.?L\.?\s*No\.?|Lic\.?\s*No\.?|ML)\b\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/\-\s]{3,24})/i
  );
  if (!hit) return null;
  return field(cleanLine(hit.match[1]).toUpperCase(), 'high', hit.line, hit.match[0]);
}

function extractSchedule(lines: TextLine[]): ExtractionField | null {
  const hit = matchLine(lines, /\b(?:Schedule\s*([A-Z1-9H]|H1)|\b(Rx)\b)/i);
  if (!hit) return null;
  const label = hit.match[1] ? `Schedule ${hit.match[1].toUpperCase()}` : 'Rx';
  return field(label, 'high', hit.line, hit.match[0]);
}

function extractDosageForm(lines: TextLine[]): ExtractionField | null {
  const hit = matchLine(
    lines,
    /\b(tablets?|capsules?|syrup|injection|drops?|gel|cream|ointment|suspension|inhaler|sachets?|powder)\b/i
  );
  if (!hit) return null;
  const value = hit.match[1].toLowerCase();
  return field(value.charAt(0).toUpperCase() + value.slice(1), 'medium', hit.line, hit.match[0]);
}

function extractComposition(lines: TextLine[]): ExtractionField | null {
  // Ingredient-with-strength patterns, including "Glimiprime M3/Glimepiride 2mg+" style pairs.
  const strengthPair = matchLine(
    lines,
    /([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}\s*(?:I\.?P\.?|USP|BP)?\s*\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu)(?:\s*(?:[+/&]|and)\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}\s*(?:I\.?P\.?|USP|BP)?\s*\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu))?)/
  );
  if (strengthPair) {
    return field(cleanLine(strengthPair.match[1]), 'medium', strengthPair.line, strengthPair.match[0]);
  }
  const structured = matchLine(
    lines,
    /((?:each\s+(?:uncoated|coated|film\s+coated)?\s*[a-z]+\s*(?:contains|contain|of)|composition)\b.{10,140})/i
  );
  if (structured) return field(cleanLine(structured.match[1]), 'medium', structured.line, structured.match[0]);
  return null;
}

const COMPANY_HINT = /\b(pharma|pharmaceuticals|laboratories|labs|ltd|limited|pvt|healthcare|biotech|remedies|life\s*sciences)\b/i;

function extractManufacturerAndMarketer(
  lines: TextLine[]
): { manufacturer: ExtractionField | null; marketer: ExtractionField | null } {
  const manufacturedBy = matchLine(lines, /\b(?:Manufactured\s*by|Mfd\.?\s*by|Mfg\.?\s*by|Mfr\.?)\b[:\s]*(.{3,60})/i);
  const marketedBy = matchLine(lines, /\b(?:Marketed\s*by|Mkt\.?\s*by)\b[:\s]*(.{3,60})/i);

  const manufacturer = manufacturedBy ? field(cleanCompany(manufacturedBy.match[1]), 'high', manufacturedBy.line, manufacturedBy.match[0]) : null;
  const marketer = marketedBy ? field(cleanCompany(marketedBy.match[1]), 'high', marketedBy.line, marketedBy.match[0]) : null;
  if (manufacturer && marketer) return { manufacturer, marketer };

  // Fallback: any line that looks like a company name (supports "Alkem Laboratories Ltd." style).
  const companies: TextLine[] = [];
  for (const line of lines) {
    if (!COMPANY_HINT.test(line.text)) continue;
    if (/\d|batch|exp|mrp|tablet|capsule|store|keep|marketed\s*by|manufactured\s*by|mfd\.?\s*by/i.test(line.text)) continue;
    if (!companies.some(c => cleanLine(c.text).toLowerCase() === cleanLine(line.text).toLowerCase())) {
      companies.push(line);
    }
  }
  return {
    manufacturer: manufacturer ?? (companies[0] ? field(cleanCompany(companies[0].text), 'medium', companies[0], companies[0].text) : null),
    marketer: marketer ?? (companies[1] ? field(cleanCompany(companies[1].text), 'medium', companies[1], companies[1].text) : null),
  };
}

function cleanCompany(raw: string): string {
  return cleanLine(raw).replace(/[,.;:]+$/, '');
}

function extractBrand(lines: TextLine[]): ExtractionField | null {
  const candidates = lines
    .filter(l => (l.orientation ?? 0) === 0)
    .map(l => ({ line: l, text: cleanLine(l.text) }))
    .filter(({ text }) => {
      if (text.length < 3 || text.length > 40) return false;
      if (/\d/.test(text)) return false;
      const words = text.split(' ');
      if (words.length > 4) return false;
      if (/\b(mg|ml|tablet|capsule|batch|exp|mfg|mrp|rx|rs|schedule|composition)\b|₹/i.test(text)) return false;
      if (COMPANY_HINT.test(text)) return false;
      const letters = text.replace(/[^A-Za-z]/g, '');
      if (letters.length < 3) return false;
      const upperRatio = letters.split('').filter(c => c === c.toUpperCase()).length / letters.length;
      return upperRatio >= 0.5;
    });
  if (candidates.length === 0) return null;
  return field(candidates[0].text, 'medium', candidates[0].line, candidates[0].line.text);
}

function extractPillImprint(lines: TextLine[]): ExtractionField | null {
  // A lone short code like "GG 249" or "I-2".
  const hit = matchLine(lines, /(?:^|\s)([A-Z]{1,3}[-\s]?\d{1,4})(?:\s|$)/);
  if (!hit) return null;
  return field(hit.match[1], 'low', hit.line, hit.match[0]);
}

/**
 * A pill photo shows only a short imprint over a plain background. Blister
 * foils and cartons carry this vocabulary — when any of it is present the
 * photo is not classified as a pill, and lone codes like "R338" are junk
 * (they are just part of the printed pack text).
 */
function photoIsPill(lines: TextLine[]): boolean {
  const text = lines.map(l => l.text).join('\n');
  const packVocabulary =
    /\b(tablets?|capsules?|blister|strip|pack|box|carton|batch|b\.?\s*no|lot|mfg|mfd|exp|expiry|m\.?r\.?p|mrp|composition|schedule|store|keep out|mg\b|mcg\b|₹|mfg\.?\s*lic)/i;
  return !packVocabulary.test(text) && countMedicineKeywords(lines) <= 1;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function extractFields(lines: TextLine[], blurScore: number, codes: DecodedCode[] = []): ExtractedData {
  const keywordHits = countMedicineKeywords(lines);
  const usable = keywordHits >= 3;
  const fields = emptyFields();
  const candidates: FieldCandidate[] = [];

  placeHit(fields, candidates, 'batch_no', extractBatch(lines));
  placeHit(fields, candidates, 'mfg_date', extractMfgDate(lines));
  placeHit(fields, candidates, 'expiry_date', extractExpiry(lines));
  placeHit(fields, candidates, 'mrp', extractMrp(lines));
  if (!fields.mfg_date && !fields.expiry_date && !candidates.some(c => c.key === 'mfg_date' || c.key === 'expiry_date')) {
    const pair = unlabeledDates(lines);
    if (pair) {
      placeHit(fields, candidates, 'mfg_date', pair.mfg);
      placeHit(fields, candidates, 'expiry_date', pair.exp);
    }
  }

  fields.manufacturing_license_no = extractLicense(lines);
  fields.schedule_marking = extractSchedule(lines);
  fields.dosage_form = extractDosageForm(lines);
  fields.composition = extractComposition(lines);
  const { manufacturer, marketer } = extractManufacturerAndMarketer(lines);
  fields.manufacturer_name = manufacturer;
  fields.marketer_name = marketer;
  fields.brand_name = extractBrand(lines);
  fields.pill_imprint = photoIsPill(lines) ? extractPillImprint(lines) : null;

  tagSourceFields(lines, fields);
  const grounded = groundExtractedData({
    usable,
    rejectReason: usable
      ? undefined
      : `Could not read enough text — only ${keywordHits} medicine keyword${keywordHits === 1 ? '' : 's'} found.`,
    keywordHits,
    fields,
    candidates,
    rawText: joinRawText(lines),
    rawTextLines: lines,
    allOcrLines: lines,   // pipeline overrides this with the full unfiltered set after the call
    unreadableRegions: findUnreadableRegions(lines),
    blurScore,
    codes,
  });

  console.log(
    'PARSED fields:',
    Object.fromEntries((Object.keys(grounded.fields) as FieldKey[]).map(k => [k, grounded.fields[k]?.value ?? null]))
  );
  console.log(
    'PARSED candidates:',
    grounded.candidates.map(c => `${c.key}=${c.value} (${c.reason})`)
  );

  return grounded;
}

/** Drop values that do not appear in raw lines; demote $ prices on Indian packs. */
export function groundExtractedData(data: ExtractedData): ExtractedData {
  const lines = data.rawTextLines;
  const raw = lines.map(l => l.text).join('\n');
  const fields = { ...data.fields };
  const candidates = [...data.candidates];

  for (const key of Object.keys(fields) as FieldKey[]) {
    const current = fields[key];
    if (!current) continue;
    if (current.origin === 'user') continue;
    const source = current.provenance?.matchedText && fuzzyContains(raw, current.provenance.matchedText)
      ? current.provenance.matchedText
      : findSourceLine(current.value, lines);
    if (!source) {
      console.log('ungrounded value removed', key, current.value);
      fields[key] = null;
      continue;
    }
    current.grounded = true;
    current.provenance = {
      ...current.provenance,
      matchedText: current.provenance?.matchedText ?? cleanLine(source),
    };
    if (hasDollarPrice(current.value) && looksIndianPack(raw)) {
      console.log('currency mismatch sent to confirm', key, current.value);
      candidates.push({
        key,
        value: current.value,
        matchedText: current.provenance.matchedText ?? source,
        bbox: current.provenance.bbox,
        confidence: 'low',
        reason: 'currency',
        ambiguousHint: 'This pack looks Indian (₹ / Rs / Mfg. Lic.) but the price used $.',
      });
      fields[key] = null;
    }
  }

  return { ...data, fields, candidates };
}

const CONF_RANK: Record<string, number> = { high: 4, medium: 3, low: 2, user: 1 };

export function mergeExtractedData(base: ExtractedData, incoming: ExtractedData): ExtractedData {
  const fields = { ...base.fields };
  for (const key of Object.keys(fields) as FieldKey[]) {
    const next = incoming.fields[key];
    if (!next) continue;
    const cur = fields[key];
    if (!cur) {
      fields[key] = next;
      continue;
    }
    const rank = (f: ExtractionField) => (f.origin === 'user' ? 1 : CONF_RANK[f.confidence] ?? 0);
    if (rank(next) > rank(cur)) fields[key] = next;
  }
  const seen = new Set(base.candidates.map(c => `${c.key}:${c.value}`));
  const candidates = [...base.candidates];
  for (const c of incoming.candidates) {
    const id = `${c.key}:${c.value}`;
    if (seen.has(id) || fields[c.key]?.value === c.value) continue;
    seen.add(id);
    candidates.push(c);
  }
  return {
    ...base,
    usable: base.usable || incoming.usable,
    keywordHits: Math.max(base.keywordHits, incoming.keywordHits),
    fields,
    candidates,
    rawText: joinRawText([...base.rawTextLines, ...incoming.rawTextLines]),
    rawTextLines: [...base.rawTextLines, ...incoming.rawTextLines],
    allOcrLines: [...(base.allOcrLines ?? []), ...(incoming.allOcrLines ?? [])],
    unreadableRegions: [...base.unreadableRegions, ...incoming.unreadableRegions],
    codes: incoming.codes.length > 0 ? incoming.codes : base.codes,
  };
}

function emptyFields(): ExtractedFields {
  return {
    brand_name: null,
    composition: null,
    dosage_form: null,
    manufacturer_name: null,
    marketer_name: null,
    manufacturing_license_no: null,
    batch_no: null,
    mfg_date: null,
    expiry_date: null,
    mrp: null,
    schedule_marking: null,
    qr_or_barcode_present: null,
    pill_imprint: null,
  };
}

function tagSourceFields(lines: TextLine[], fields: ExtractedFields): void {
  for (const line of lines) {
    const fed: string[] = [];
    for (const [key, value] of Object.entries(fields) as Array<[FieldKey, ExtractionField | null]>) {
      if (!value?.provenance) continue;
      if (value.provenance.bbox === line.bbox) fed.push(key);
    }
    if (fed.length > 0) line.fields = fed;
  }
}

/** Low-confidence lines become the unreadable-regions summary data. */
function findUnreadableRegions(lines: TextLine[]): Array<{ bbox: BBox; text: string; confidence: number }> {
  return lines
    .filter(line => line.confidence === 'low')
    .map(line => ({
      bbox: line.bbox,
      text: cleanLine(line.text),
      confidence: line.wordConfidence ?? 0,
    }));
}

/** Reference-data lookup for the company-product check. */
export function findCatalogEntry(manufacturer: string): ManufacturerCatalogEntry | undefined {
  const needle = manufacturer.toLowerCase();
  return productCatalog.find(
    entry =>
      entry.manufacturer.toLowerCase() === needle ||
      entry.manufacturer.toLowerCase().includes(needle) ||
      needle.includes(entry.manufacturer.toLowerCase())
  );
}
