import type {
  BatchInfoResult,
  BatchReference,
  DecodedCode,
  DrugClassInfo,
  ExtractedFields,
  ExtractionField,
  Identification,
  IdentificationMethod,
  ProductInfo,
} from '../types';
import { productCatalog } from './extract';
import { parseCodePayload } from './barcode';
import drugClassesJson from '../data/drug_classes.json';
import batchesJson from '../data/batches.json';
import manufacturersJson from '../data/manufacturers.json';
import productInfoJson from '../data/product_info.json';

// ---------------------------------------------------------------------------
// Reference data (static, versioned JSON — never hardcoded in flow logic)
// ---------------------------------------------------------------------------

const DRUG_CLASSES = drugClassesJson as Record<string, string>;
const BATCHES = batchesJson as BatchReference[];
const MANUFACTURER_PATTERNS = manufacturersJson as Array<{
  manufacturer: string;
  batchPattern: { description: string; regex: string };
}>;

/** Common words ignored when matching composition ingredients. */
const INGREDIENT_STOP_WORDS = new Set([
  'each', 'tablet', 'tablets', 'capsule', 'capsules', 'contains', 'contain',
  'uncoated', 'coated', 'film', 'sustained', 'release', 'and', 'with', 'the',
  'composition', 'of', 'ip', 'usp', 'bp', 'plus', 'eq', 'equivalent', 'to',
]);

function tokenizeComposition(composition: string): string[] {
  return composition
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(w => w.length > 2 && !INGREDIENT_STOP_WORDS.has(w));
}

/**
 * Map composition ingredients to drug classes via data/drug_classes.json.
 * Ingredient keys may be single words ('metformin') or phrases
 * ('amlodipine besylate') — matching is token-substring based.
 */
export function classifyComposition(composition: string | undefined): DrugClassInfo | null {
  if (!composition) return null;
  const tokens = tokenizeComposition(composition);
  if (tokens.length === 0) return null;
  const classes: string[] = [];
  const matched: string[] = [];
  for (const [ingredient, className] of Object.entries(DRUG_CLASSES)) {
    const ingredientTokens = ingredient.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const hit = ingredientTokens.every(t => tokens.some(tok => tok === t || tok.startsWith(t) || t.startsWith(tok)));
    if (hit && !classes.includes(className)) {
      classes.push(className);
      matched.push(ingredient);
    }
  }
  if (classes.length === 0) return null;
  return { classes, matchedIngredients: matched };
}

// ---------------------------------------------------------------------------
// Identification fallback chain
// ---------------------------------------------------------------------------

function brandFromCodePayloads(codes: DecodedCode[]): { name?: string; method: IdentificationMethod; detail: string } | null {
  for (const code of codes) {
    const parsed = parseCodePayload(code.payload);
    if (parsed.kind === 'url' && parsed.domain) {
      return {
        method: 'code-url',
        detail: `Decoded ${code.format} links to ${parsed.domain}`,
      };
    }
    if (parsed.kind === 'gs1') {
      const viaGtin = parsed.gtin ? matchGtinInCatalog(parsed.gtin) : undefined;
      if (viaGtin) {
        return { name: viaGtin, method: 'code-gtin', detail: `GTIN ${parsed.gtin} matched reference data` };
      }
      return { method: 'code-gtin', detail: `Decoded ${code.format} GS1 payload (GTIN ${parsed.gtin ?? 'n/a'})` };
    }
  }
  return null;
}

/** Find a GTIN recorded on any catalog product (products.json may carry gtins). */
function matchGtinInCatalog(gtin: string): string | undefined {
  for (const entry of productCatalog) {
    for (const product of entry.products) {
      const gtins = (product as { gtins?: string[] }).gtins ?? [];
      if (gtins.includes(gtin)) return product.name;
    }
  }
  return undefined;
}

/** Fuzzy similarity on normalized strings (Dice coefficient over bigrams). */
function similarity(a: string, b: string): number {
  const normA = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normB = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normA.length < 3 || normB.length < 3) return 0;
  if (normA === normB) return 1;
  const bigrams = (s: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const gram = s.slice(i, i + 2);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };
  const gramsA = bigrams(normA);
  const gramsB = bigrams(normB);
  let overlap = 0;
  for (const [gram, countA] of gramsA) {
    const countB = gramsB.get(gram) ?? 0;
    overlap += Math.min(countA, countB);
  }
  return (2 * overlap) / (normA.length - 1 + normB.length - 1);
}

const BEST_BRAND_MATCH = 0.82;

function fuzzyBrandMatch(brand: string): { name: string; score: number } | null {
  let best: { name: string; score: number } | null = null;
  for (const entry of productCatalog) {
    for (const product of entry.products) {
      const score = similarity(brand, product.name);
      if (score >= BEST_BRAND_MATCH && (!best || score > best.score)) {
        best = { name: product.name, score };
      }
    }
  }
  return best;
}

/** Brand-like candidate lines: short, mostly letters, not field values. */
function brandCandidates(lines: TextLineList): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const text = line.text.replace(/\s+/g, ' ').trim();
    if (text.length < 4 || text.length > 40) continue;
    if (/\d|₹|batch|exp\b|mfg|mrp|rx|schedule|composition|tablets?|capsules?/i.test(text)) continue;
    const letters = text.replace(/[^A-Za-z ]/g, '');
    if (letters.length < 4) continue;
    if (!out.some(t => t.toLowerCase() === text.toLowerCase())) out.push(text);
  }
  return out.slice(0, 12);
}

type TextLineList = Array<{ text: string }>;

/**
 * Run the identification fallback chain in spec order. Returns null when
 * nothing identified — we never invent a name.
 */
export function identifyProduct(
  fields: ExtractedFields,
  codes: DecodedCode[],
  rawTextLines: TextLineList,
  userTypedName?: string
): Identification | null {
  // (a) QR/barcode payload or GTIN vs products.json
  const fromCode = brandFromCodePayloads(codes);
  if (fromCode) {
    const catMatch = fromCode.name ? matchCatalogName(fromCode.name) : null;
    if (catMatch) {
      return {
        method: fromCode.method,
        confidence: 'high',
        productName: catMatch,
        detail: `${fromCode.detail} → ${catMatch} in reference data`,
      };
    }
    if (fromCode.method === 'code-gtin') {
      // A GS1 code with a GTIN but no catalog hit is still a code-based lead.
      return { method: fromCode.method, confidence: 'low', detail: fromCode.detail };
    }
    if (fromCode.method === 'code-url' && fields.brand_name) {
      return {
        method: 'code-url',
        confidence: 'medium',
        productName: fields.brand_name.value,
        detail: `${fromCode.detail}; brand text read as "${fields.brand_name.value}"`,
      };
    }
    return { method: fromCode.method, confidence: 'low', detail: fromCode.detail };
  }

  // (b) composition words from the OCR text
  const composition = fields.composition?.value;
  const classInfo = classifyComposition(composition);
  if (composition && classInfo) {
    const catMatch = matchCompositionInCatalog(composition);
    if (catMatch) {
      return {
        method: 'composition',
        confidence: 'high',
        productName: catMatch,
        detail: `Ingredients match ${catMatch} in reference data`,
      };
    }
    return {
      method: 'composition',
      confidence: 'medium',
      detail: `Ingredients (${classInfo.matchedIngredients.join(', ')}) recognized`,
    };
  }

  // (c) fuzzy match of brand-like text against products.json
  const brand = fields.brand_name?.value;
  if (brand) {
    const match = fuzzyBrandMatch(brand);
    if (match) {
      return {
        method: 'fuzzy-brand',
        confidence: match.score >= 0.95 ? 'high' : 'medium',
        productName: match.name,
        detail: `"${brand}" closely matches ${match.name} in reference data (${Math.round(match.score * 100)}%)`,
      };
    }
  }
  const fromLines = brandCandidates(rawTextLines);
  for (const candidate of fromLines) {
    const match = fuzzyBrandMatch(candidate);
    if (match) {
      return {
        method: 'fuzzy-brand',
        confidence: 'low',
        productName: match.name,
        detail: `Text "${candidate}" resembles ${match.name} (${Math.round(match.score * 100)}%)`,
      };
    }
  }

  // (d) pill imprint, shape and colour — low confidence lead only
  const imprint = fields.pill_imprint?.value;
  if (imprint) {
    return {
      method: 'pill',
      confidence: 'low',
      detail: `Pill imprint "${imprint}" — not enough to identify without a reference imprint database`,
    };
  }

  // (e) user typed the name (wired through the collect/manual-entry flow)
  if (userTypedName?.trim()) {
    return {
      method: 'user',
      confidence: 'low',
      productName: userTypedName.trim(),
      detail: 'Name entered by user — not verified against a reference',
    };
  }

  return null;
}

function matchCatalogName(name: string): string | undefined {
  const needle = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const entry of productCatalog) {
    for (const product of entry.products) {
      const hay = product.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (hay === needle) return product.name;
    }
  }
  return undefined;
}

function matchCompositionInCatalog(composition: string): string | undefined {
  const tokens = new Set(tokenizeComposition(composition));
  for (const entry of productCatalog) {
    for (const product of entry.products) {
      const strengthTokens = new Set(
        product.strengths.flatMap(s => s.toLowerCase().match(/[a-z]+/g) ?? [])
      );
      // The product's ingredients appear in the composition text.
      const ingredientWords = [...tokens].filter(t => !/^\d/.test(t) && !strengthTokens.has(t));
      const productTokens = tokenizeComposition(product.name);
      const allPresent = productTokens.every(t => tokens.has(t));
      if (allPresent && productTokens.length > 0 && ingredientWords.length <= productTokens.length + 2) {
        return product.name;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Batch information panel
// ---------------------------------------------------------------------------

/**
 * Look up the batch in data/batches.json and run a format check against the
 * manufacturer's known pattern (data/manufacturers.json) when one exists.
 */
export function lookupBatchInfo(batchValue: string, manufacturer?: string): BatchInfoResult {
  const normalized = batchValue.trim().toUpperCase();
  const reference = BATCHES.find(entry => entry.batch.toUpperCase() === normalized) ?? null;

  let formatCheck: BatchInfoResult['formatCheck'] = null;
  const maker = (manufacturer ?? '').toLowerCase();
  const patternEntry = MANUFACTURER_PATTERNS.find(
    entry => maker.includes(entry.manufacturer.toLowerCase()) || entry.manufacturer.toLowerCase().includes(maker)
  );
  if (patternEntry) {
    let ok = false;
    try {
      ok = new RegExp(patternEntry.batchPattern.regex, 'i').test(normalized);
    } catch {
      ok = false;
    }
    formatCheck = {
      status: ok ? 'pass' : 'fail',
      detail: ok
        ? `Matches ${patternEntry.manufacturer}'s known batch pattern (${patternEntry.batchPattern.description}).`
        : `Does not match ${patternEntry.manufacturer}'s known batch pattern (${patternEntry.batchPattern.description}).`,
    };
  } else {
    formatCheck = {
      status: 'unknown',
      detail: 'No known batch pattern for this manufacturer — format cannot be checked.',
    };
  }

  return { batch: batchValue, reference, formatCheck };
}

// ---------------------------------------------------------------------------
// Product info lookup (uses / sideEffects / warnings from product_info.json)
// ---------------------------------------------------------------------------

const PRODUCT_INFO = productInfoJson as ProductInfo[];

/**
 * Match the scanned pack against the product_info dataset.
 * Searches structured fields first, then falls back to raw OCR text lines
 * so a match works even when the parser extracted nothing.
 *
 * Scoring:
 *   brand keyword in brand field or raw text  → 4 pts
 *   ingredient keyword in composition or raw  → 2 pts
 *   manufacturer keyword in mfr field or raw  → 1 pt
 */
export function lookupProductInfo(
  fields: ExtractedFields,
  rawTextLines: Array<{ text: string }> = []
): ProductInfo | null {
  const rawText = rawTextLines.map(l => l.text).join(' ').toLowerCase();

  const brandVal   = (fields.brand_name?.value ?? '').toLowerCase();
  const compVal    = (fields.composition?.value ?? '').toLowerCase();
  const mfrVal     = ((fields.manufacturer_name?.value ?? '') + ' ' + (fields.marketer_name?.value ?? '')).toLowerCase();

  // Combined search string: structured fields + raw OCR lines
  const allText = `${brandVal} ${compVal} ${mfrVal} ${rawText}`;

  let best: { info: ProductInfo; score: number } | null = null;

  for (const entry of PRODUCT_INFO) {
    let score = 0;

    // 1. Brand keyword (4 pts — strongest signal)
    for (const kw of entry.brandKeywords ?? []) {
      if (allText.includes(kw.toLowerCase())) score += 4;
    }

    // 2. Ingredient keyword (2 pts each)
    for (const ingredient of entry.ingredients) {
      for (const kw of ingredient.keywords) {
        if (allText.includes(kw.toLowerCase())) score += 2;
      }
    }

    // 3. Manufacturer keyword (1 pt each)
    for (const kw of entry.manufacturerKeywords ?? []) {
      if (allText.includes(kw.toLowerCase())) score += 1;
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { info: entry, score };
    }
  }

  if (best) {
    console.log('[lookupProductInfo] matched:', best.info.brand, 'score', best.score);
  }
  return best ? best.info : null;
}

// ---------------------------------------------------------------------------
// Brand-name fallback for missing OCR reads
// ---------------------------------------------------------------------------

/** Fill a missing brand name from the identification chain (provenance kept). */
export function brandFromIdentification(identification: Identification | null): ExtractionField | null {
  if (!identification?.productName) return null;
  return {
    value: identification.productName,
    confidence: identification.confidence === 'high' ? 'medium' : 'low',
    origin: 'image',
    provenance: { matchedText: identification.detail },
  };
}
