import type {
  BBox,
  DecodedCode,
  ExtractedData,
  ExtractedFields,
  ExtractionField,
  FieldKey,
  TextLine,
} from '../types';
import productsJson from '../data/products.json';

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
  matchedText: string
): ExtractionField {
  return {
    value,
    confidence,
    origin: 'image',
    provenance: {
      bbox: line.bbox,
      matchedText: cleanLine(matchedText),
      runLabel: line.runLabel,
    },
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

function extractBatch(lines: TextLine[]): ExtractionField | null {
  // (B\.?\s*No\.?|Batch\s*No\.?|Lot)\s*[:.\-]?\s*([A-Z0-9]{5,12})
  const hit = matchLine(
    lines,
    /\b(?:B\.?\s*No\.?|Batch\s*No\.?|Batch|Lot)\b\s*[:.\-]?\s*([A-Za-z0-9][A-Za-z0-9-]{4,15})/i
  );
  if (!hit) return null;
  const value = hit.match[1].toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return field(value, /\b(b\.?\s*no|batch|lot)\b/i.test(hit.line.text) ? 'high' : 'medium', hit.line, hit.match[0]);
}

function extractMfgDate(lines: TextLine[]): ExtractionField | null {
  // (MFG|MFD|Mfg.?\s*Date)\s*[:.\-]?\s*(\d{2}[\/\-]\d{4}|[A-Za-z]{3}\.?\s*\d{2,4})
  const hit = matchLine(
    lines,
    new RegExp(
      `\\b(?:MFG|MFD|MFGD|Mfg\\.?\\s*Date|Mfd\\.?\\s*Date|Mfgd)\\b\\s*[:.]?\\s*-?\\s*(\\d{2}\\s*[/-]\\s*\\d{4}|\\d{2}\\s*[/-]\\s*\\d{2}|${MONTH_RE}\\.?\\s*[-/ ]\\s*\\d{2,4})`,
      'i'
    )
  );
  if (!hit) return null;
  return field(normalizeDate(hit.match[1]), 'high', hit.line, hit.match[0]);
}

function extractExpiry(lines: TextLine[]): ExtractionField | null {
  // (EXP|Expiry)\s*[:.\-]?\s*(\d{2}[\/\-]\d{4}|[A-Za-z]{3}\.?\s*\d{2,4})
  const hit = matchLine(
    lines,
    new RegExp(
      `\\b(?:EXP|Expiry|Exp\\.?\\s*Date|EXP\\s*Date|Use\\s*By|Best\\s*Before)\\b\\s*[:.]?\\s*-?\\s*(\\d{2}\\s*[/-]\\s*\\d{4}|\\d{2}\\s*[/-]\\s*\\d{2}|${MONTH_RE}\\.?\\s*[-/ ]\\s*\\d{2,4})`,
      'i'
    )
  );
  if (!hit) return null;
  return field(normalizeDate(hit.match[1]), 'high', hit.line, hit.match[0]);
}

function extractMrp(lines: TextLine[]): ExtractionField | null {
  // M\.?R\.?P\.?\s*[:.\-]?\s*(?:Rs\.?)?\s*([\d.]+)
  const hit = matchLine(lines, /\bM\.?\s?R\.?\s?P\.?\s*[:.]?\s*-?\s*(?:Rs\.?|INR|₹)?\s*([0-9]+(?:[.,][0-9]{1,2})?)/i);
  if (!hit) return null;
  const value = `₹${hit.match[1].replace(',', '.')}`;
  return field(value, 'high', hit.line, hit.match[0]);
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

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function extractFields(lines: TextLine[], blurScore: number, codes: DecodedCode[] = []): ExtractedData {
  const keywordHits = countMedicineKeywords(lines);
  // 3+ keyword hits = medicine pack; 0-2 = inconclusive → "review", never "fail".
  const usable = keywordHits >= 3;
  const fields = emptyFields();

  if (usable) {
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
    fields.pill_imprint = extractPillImprint(lines);
  }

  tagSourceFields(lines, fields);

  return {
    usable,
    rejectReason: usable
      ? undefined
      : `Could not read enough text — only ${keywordHits} medicine keyword${keywordHits === 1 ? '' : 's'} found.`,
    keywordHits,
    fields,
    rawTextLines: lines,
    unreadableRegions: findUnreadableRegions(lines),
    blurScore,
    codes,
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
