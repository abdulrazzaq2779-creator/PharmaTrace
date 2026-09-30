import type { ExtractedData, ExtractedFields, ExtractionField, TextLine } from '../types';
import productsJson from '../data/products.json';

/** The reference catalog for the company-product consistency check (STEP 5). */
export const productCatalog: ManufacturerCatalogEntry[] = productsJson;

export type ManufacturerCatalogEntry = {
  manufacturer: string;
  products: Array<{ name: string; strengths: string[]; dosageForms: string[] }>;
};

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', SEPT: '09', OCT: '10', NOV: '11', DEC: '12',
};

const MONTH_RE = '(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)';

/** Remove OCR junk from line ends and collapse whitespace. */
export function cleanLine(text: string): string {
  return text
    .replace(/[|_~^`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function field(value: string, confidence: ExtractionField['confidence'], sourceLines: number): ExtractionField {
  return { value, confidence, sourceLines };
}

/** Test a line against a regex; return cleaned match text or null. */
function matchLine(lines: TextLine[], re: RegExp): { line: TextLine; match: RegExpMatchArray } | null {
  for (const line of lines) {
    const match = line.text.match(re);
    if (match) return { line, match };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field-level patterns. Each returns ExtractionField | null — never guesses.
// ---------------------------------------------------------------------------

function extractBatch(lines: TextLine[]): ExtractionField | null {
  const hit =
    matchLine(lines, /(?:batch|b\.?no|lot|b|batch\s*no)[.:\s#-]*([A-Z0-9][A-Z0-9\/-]{2,19})/i) ??
    matchLine(lines, /(?:^|\s)(?:b|lot)\s*[:.\-]?\s*([A-Z0-9]{4,20})(?:\s|$)/i);
  if (!hit) return null;
  return field(hit.match[1].toUpperCase(), /batch|lot|b\.?no/i.test(hit.line.text) ? 'high' : 'medium', 1);
}

function extractMfgDate(lines: TextLine[]): ExtractionField | null {
  const hit = matchLine(lines, new RegExp(`m(?:anufactur(?:ing|ed)?|fg|fd|mkd)?[.:\\s]*?(?:date)?[.:\\s]*(${MONTH_RE}[_\\s\\-\\/]\\d{2,4}|\\d{2}[_\\s\\-\\/]${MONTH_RE}[_\\s\\-\\/]\\d{2,4}|\\d{2}[\\/\\-\\.]\\d{4}|\\d{4}[\\/\\-\\.]\\d{2})`, 'i'));
  if (!hit) return null;
  return field(normalizeDate(hit.match[1]), 'high', 1);
}

function extractExpiry(lines: TextLine[]): ExtractionField | null {
  const hit = matchLine(lines, new RegExp(`(?:exp|expiry|expiration|use\\s*by|best\\s*before)[.:\\s]*(${MONTH_RE}[_\\s\\-\\/]\\d{2,4}|\\d{2}[_\\s\\-\\/]${MONTH_RE}[_\\s\\-\\/]\\d{2,4}|\\d{2}[\\/\\-\\.]\\d{4}|\\d{4}[\\/\\-\\.]\\d{2})`, 'i'));
  if (!hit) return null;
  return field(normalizeDate(hit.match[1]), 'high', 1);
}

/** Normalize month-name or numeric dates to "MM/YYYY" for display + parsing. */
export function normalizeDate(raw: string): string {
  const text = raw.toUpperCase().replace(/[._]/g, ' ').trim();

  const monthName = text.match(new RegExp(`(${MONTH_RE})[\\s\\/-]*(\\d{2,4})`));
  if (monthName) {
    const mm = MONTHS[monthName[1] === 'SEPT' ? 'SEP' : monthName[1]];
    return `${mm}/${monthName[2].padStart(monthName[2].length === 2 ? '20' : 4).slice(-4).length === 4 ? monthName[2].padStart(4, '20') : monthName[2]}`;
  }

  const numeric = text.match(/(\d{2})[\s/-](\d{2,4})/);
  if (numeric) {
    const [, a, b] = numeric;
    // "12/2025" or "12/25" → MM/YYYY ; "2025/12" stays year-first
    if (b.length === 4 && Number(b) > 1900) return `${a}/${b}`;
    if (b.length === 2) return `${a}/20${b}`;
    if (a.length === 4) return `${b}/${a}`;
    return `${a}/${b}`;
  }
  return text;
}

function extractMrp(lines: TextLine[]): ExtractionField | null {
  const hit = matchLine(lines, /(?:m\.?r\.?p|price)[.:\s]*(?:rs\.?|inr|₹)?\s*([0-9]{1,4}(?:[.,]\d{1,2})?)(?:\s*(?:inr|rs|₹))?/i);
  if (!hit) return null;
  return field(`₹${hit.match[1]}`, 'high', 1);
}

function extractLicense(lines: TextLine[]): ExtractionField | null {
  const hit = matchLine(lines, /(?:m\.?l\.?(?:\s*no)?|mfg\.?\s*lic(?:e?n[cs]e)?|lic(?:e?n[cs]e)\s*no)[.:\s]*([A-Z0-9\/\-]{5,25})/i);
  if (!hit) return null;
  return field(hit.match[1].toUpperCase(), 'high', 1);
}

function extractSchedule(lines: TextLine[]): ExtractionField | null {
  const hit = matchLine(lines, /\b(?:schedule\s*([A-Z1-9H]|H1)|([Rx÷]\s?s)|\bDrugs\s+and\s+Cosmetics\b)/i);
  if (!hit) {
    return null;
  }
  const label = hit.match[1] ? `Schedule ${hit.match[1].toUpperCase()}` : hit.match[2] ? 'Rx' : 'Drugs and Cosmetics Act';
  return field(label, 'high', 1);
}

function extractDosageForm(lines: TextLine[]): ExtractionField | null {
  const hit = matchLine(lines, /\b(tablets?|capsules?|syrup|injection|drops?|gel|cream|ointment|suspension|inhaler|sachets?|powder)\b/i);
  if (!hit) return null;
  const value = hit.match[1].toLowerCase();
  return field(value.charAt(0).toUpperCase() + value.slice(1), 'medium', 1);
}

function extractComposition(lines: TextLine[]): ExtractionField | null {
  // Look for "Each <form> contains:" or ingredient-with-strength patterns like "Amlodipine 5mg + Atenolol 50mg" or "Paracetamol I.P. 500mg".
  const structured = matchLine(
    lines,
    /((?:each\s+(?:uncoated|coated|film\s+coated)?\s*[a-z]+\s*(?:contains|contain|of)|composition)\b.{10,120})/i
  );
  const strengthPair = matchLine(
    lines,
    /([A-Z][A-Za-z]{4,}(?:\s+[A-Z][A-Za-z]{3,})?\s+(?:I\.?P\.?|USP|BP)?\s*\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu)(?:\s*[/＋+&]\s*[A-Z][A-Za-z]{4,}\s*(?:I\.?P\.?|USP|BP)?\s*\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu))?)/
  );
  if (structured) return field(cleanLine(structured.match[1]), 'medium', 1);
  if (strengthPair) return field(cleanLine(strengthPair.match[1]), 'medium', 1);
  return null;
}

function isNoiseWord(word: string): boolean {
  const noise = ['the', 'and', 'for', 'from', 'with', 'each', 'contains', 'tablet', 'tablets', 'capsule', 'keep', 'out', 'of', 'reach', 'children', 'store', 'below', 'manufactured', 'marketed', 'by', ' india', 'ltd', 'limited', 'pharma', 'pvt'];
  return noise.includes(word.toLowerCase());
}

function extractCompanyNames(lines: TextLine[]): string[] {
  const names: string[] = [];
  const afterMarker = matchLine(lines, /(?:manufactured|marketed|mfd|mkt)\s*(?:by|:)\s*(.{3,60})/i);
  if (afterMarker) names.push(cleanLine(afterMarker.match[1]));
  for (const line of lines) {
    if (/\b(pharma|pharmaceuticals|laboratories|labs|ltd|limited|pvt|healthcare|biotech)\b/i.test(line.text)) {
      const cleaned = cleanLine(line.text);
      if (cleaned.length >= 4 && !names.some(n => n.toLowerCase() === cleaned.toLowerCase())) {
        names.push(cleaned);
      }
    }
  }
  return names;
}

function extractManufacturerAndMarketer(lines: TextLine[]): {
  manufacturer: ExtractionField | null;
  marketer: ExtractionField | null;
} {
  const manufacturedBy = matchLine(lines, /manufactured\s*(?:by|:)\s*(.{3,60})/i);
  const marketedBy = matchLine(lines, /marketed\s*(?:by|:)\s*(.{3,60})/i);
  const manufacturer = manufacturedBy ? field(cleanName(manufacturedBy.match[1]), 'high', 1) : null;
  const marketer = marketedBy ? field(cleanName(marketedBy.match[1]), 'high', 1) : null;

  if (manufacturer && marketer) return { manufacturer, marketer };

  const companies = extractCompanyNames(lines).filter(name => !/(the|and|for)\s/i.test(name));
  if (!manufacturer && companies.length > 0) {
    return {
      manufacturer: field(companies[0], 'medium', 1),
      marketer: marketer ?? (companies.length > 1 ? field(companies[1], 'medium', 1) : null),
    };
  }
  return { manufacturer, marketer };
}

/** Trim trailing noise from a company name. */
function cleanName(raw: string): string {
  return cleanLine(raw).replace(/[,.;]+$/, '');
}

function extractBrand(lines: TextLine[]): ExtractionField | null {
  // Brand names: short, mostly-caps lines near the top, not noise words.
  const candidates = lines
    .filter(l => l.band > 0 && l.band <= 3 && l.orientation === 0)
    .map(l => cleanLine(l.text))
    .filter(text => {
      if (text.length < 3 || text.length > 30) return false;
      if (/\d/.test(text)) return false;
      const words = text.split(' ');
      if (words.length > 3) return false;
      if (words.every(isNoiseWord)) return false;
      if (/(mg|ml|tablet|capsule|batch|exp|mfg|mrp|rx|rs|₹)/i.test(text)) return false;
      const letters = text.replace(/[^A-Za-z]/g, '');
      if (letters.length < 3) return false;
      // Mostly-uppercase heuristic (brand panels are usually caps or title case)
      const upperRatio = letters.split('').filter(c => c === c.toUpperCase()).length / letters.length;
      return upperRatio >= 0.5;
    });
  if (candidates.length === 0) return null;
  return field(candidates[0], 'medium', 1);
}

// ---------------------------------------------------------------------------
// Medicine-pack detection (usable flag)
// ---------------------------------------------------------------------------

const MEDICINE_SIGNALS: RegExp[] = [
  /batch|b\.?no|lot\b/i,
  new RegExp(`\\bexp(?:iry)?\\b|mfg|mfd|use\\s*before|best\\s*before`, 'i'),
  /m\.?r\.?p|₹|\brs\.?\b/i,
  new RegExp(`\\b(?:tablet|capsule|syrup|injection|suspension|ointment|drops)\\b`, 'i'),
  /\bmg\b|\bmcg\b|\biu\b/i,
  /\bschedule|rx\b/i,
  /composition|ingredients|each\s+(?:tablet|capsule)/i,
  /keep\s+out\s+of\s+reach|store\s+in\s+a\s+cool/i,
];

export function looksLikeMedicinePack(lines: TextLine[]): { usable: boolean; reason?: string } {
  const meaningful = lines.filter(l => cleanLine(l.text).length >= 3);
  if (meaningful.length === 0) {
    return { usable: false, reason: 'No readable text found on the image.' };
  }
  const hits = MEDICINE_SIGNALS.filter(re => meaningful.some(l => re.test(l.text))).length;
  if (hits >= 2) return { usable: true };
  return {
    usable: false,
    reason:
      hits === 1
        ? 'Text was found, but it does not look like a medicine package (too few medicine-related labels).'
        : 'This does not appear to be a medicine package.',
  };
}

// ---------------------------------------------------------------------------
// Main entry: build ExtractedData from merged OCR lines
// ---------------------------------------------------------------------------

export function extractFields(lines: TextLine[], blurScore: number): ExtractedData {
  const usableCheck = looksLikeMedicinePack(lines);
  const fields = emptyFields();

  if (usableCheck.usable) {
    fields.batch_no = extractBatch(lines);
    fields.mfg_date = extractMfgDate(lines);
    fields.expiry_date = extractExpiry(lines);
    fields.mrp = extractMrp(lines);
    fields.manufacturing_license_no = extractLicense(lines);
    fields.schedule_marking = extractSchedule(lines);
    fields.dosage_form = extractDosageForm(lines);
    fields.composition = extractComposition(lines);
    const { manufacturer, marketer } = extractManufacturerAndMarketer(lines);
    fields.manufacturer_name = manufacturer;
    fields.marketer_name = marketer;
    fields.brand_name = extractBrand(lines);
    // QR/barcode detection is done at the pipeline level via the vision model;
    // OCR-only fallback cannot detect it reliably, so leave null (shown as "Not found").
    fields.pill_imprint = extractPillImprint(lines);
  }

  // Tag which fields each raw line fed (for bounding-box tooltips, STEP 4).
  tagSourceFields(lines, fields);

  return {
    usable: usableCheck.usable,
    rejectReason: usableCheck.reason,
    fields,
    rawTextLines: lines,
    unreadableRegions: findUnreadableRegions(lines),
    rotatedPassLines: lines.filter(l => l.orientation === 1),
    blurScore,
  };
}

function extractPillImprint(lines: TextLine[]): ExtractionField | null {
  // A lone short code like "GG 249" or "I-2" — only if other signals are pack-level.
  const hit = matchLine(lines, /(?:^|\s)([A-Z]{1,3}[-\s]?\d{1,4})(?:\s|$)/);
  if (!hit) return null;
  return field(hit.match[1], 'low', 1);
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
    for (const [key, value] of Object.entries(fields)) {
      if (!value) continue;
      const valueCore = value.value.replace(/[₹\s]/g, '').toLowerCase();
      if (valueCore.length >= 3 && line.text.toLowerCase().includes(valueCore.slice(0, Math.min(8, valueCore.length)))) {
        fed.push(key);
      }
    }
    if (fed.length > 0) line.fields = fed;
  }
}

/** Low-confidence lines double as "unreadable regions" for the UI. */
function findUnreadableRegions(lines: TextLine[]): Array<{ bbox: TextLine['bbox']; reason: string }> {
  return lines
    .filter(line => line.confidence === 'low' && cleanLine(line.text).length >= 2)
    .map(line => ({
      bbox: line.bbox,
      reason: `Read as "${cleanLine(line.text)}" with low confidence — verify manually.`,
    }));
}

// STEP 5 helper: reference-data lookup for the company-product check.
export function findCatalogEntry(manufacturer: string): ManufacturerCatalogEntry | undefined {
  const needle = manufacturer.toLowerCase();
  return productCatalog.find(
    entry =>
      entry.manufacturer.toLowerCase() === needle ||
      entry.manufacturer.toLowerCase().includes(needle) ||
      needle.includes(entry.manufacturer.toLowerCase())
  );
}
