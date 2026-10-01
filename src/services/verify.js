import products from '../data/products.json';
import productInfo from '../data/product_info.json';

/**
 * Verification engine.
 *
 * createVerifier(products) -> verify({ rawText, fields })
 *
 * `rawText` must be EVERY recognized line from ALL OCR/vision passes, bands,
 * crops and rotations joined into one string — not only the lines that matched
 * the date/batch regexes. The verifier lower-cases it once and searches it for
 * every reference signal.
 *
 * All facts (brands, ingredients, manufacturers, uses, side effects, warnings,
 * licence numbers) come from the reference JSON — nothing is hardcoded here.
 */

const REFERENCE_PRODUCTS = products ?? [];
const REFERENCE_INFO = productInfo ?? [];

/** Lower-case and collapse everything non-alphanumeric to single spaces. */
function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Compact form: all non-alphanumerics removed (for codes / licence digits). */
function compact(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function checkStatus(status, name, reason) {
  return { status, name, reason };
}

/** 'Each uncoated tablet contains: Metformin 1000mg' -> ['metformin 1000mg', ...] */
function ingredientFacts(text) {
  const out = [];
  const re = /([a-z][a-z]*(?:\s+[a-z]+)*?(?:\s*(?:i\.?p\.?|usp|bp))?\s*\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu))/gi;
  let m;
  while ((m = re.exec(text))) out.push(m[1].replace(/\s+/g, ' ').trim());
  return out;
}

function bestReferenceEntry(brandValue) {
  const needle = normalize(brandValue);
  if (!needle) return null;
  let best = null;
  for (const entry of REFERENCE_PRODUCTS) {
    for (const product of entry.products) {
      const name = normalize(product.name);
      if (!name) continue;
      if (needle === name || needle.includes(name) || name.includes(needle)) {
        const score = name.length;
        if (!best || score > best.score) best = { entry, product, score };
      }
    }
  }
  return best;
}

/** Find the product_info.json entry for a brand (or its catalog product name). */
function infoForBrand(brandValue) {
  const needle = normalize(brandValue);
  if (!needle) return null;
  let best = null;
  for (const info of REFERENCE_INFO) {
    const brand = normalize(info.brand);
    const keywords = [brand, ...(info.brandKeywords ?? []).map(normalize)].filter(Boolean);
    const hit = keywords.some(k => needle === k || needle.includes(k) || k.includes(needle));
    if (hit && (!best || brand.length > best.brandLength)) {
      best = { info, brandLength: brand.length };
    }
  }
  return best ? best.info : null;
}

function manufacturerCatalogEntry(manufacturerValue) {
  const needle = normalize(manufacturerValue);
  if (!needle) return null;
  return (
    REFERENCE_PRODUCTS.find(entry => {
      const name = normalize(entry.manufacturer);
      return name && (needle.includes(name) || name.includes(needle));
    }) ?? null
  );
}

// ---------------------------------------------------------------------------
// Field checks (every status is derived from rawText + fields + reference data)
// ---------------------------------------------------------------------------

function expiryCheck(fields, now) {
  const value = fields?.exp ?? fields?.expiry_date;
  if (!value) {
    return checkStatus('unavailable', 'Expiry date', 'Not found in the recognized text — cannot check.');
  }
  const cleaned = String(value).toUpperCase().replace(/[._]/g, ' ').trim();
  const monthName = cleaned.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)[A-Z]*\s*[-/ ]?\s*(\d{2,4})\b/);
  const numeric = cleaned.match(/\b(\d{1,2})\s*[-/]\s*(\d{2,4})\b/);
  let month = null;
  let year = null;
  if (monthName) {
    const months = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 };
    month = months[monthName[1]];
    year = Number(monthName[2]);
  } else if (numeric) {
    month = Number(numeric[1]);
    year = Number(numeric[2]);
  }
  if (!month || !year || month < 1 || month > 12) {
    return checkStatus('review', 'Expiry date', `"${value}" was read but could not be interpreted as a date.`);
  }
  if (year < 100) year += 2000;
  const endOfMonth = new Date(year, month, 0, 23, 59, 59);
  if (endOfMonth.getTime() < now.getTime()) {
    return checkStatus('fail', 'Expiry date', `Expired ${month}/${year} — do not use.`);
  }
  return checkStatus('pass', 'Expiry date', `Valid until end of ${month}/${year}.`);
}

function batchCheck(fields, rawText) {
  const batch = fields?.batch;
  if (!batch) {
    return checkStatus('unavailable', 'Batch number', 'Not found in the recognized text — cannot check.');
  }
  const presentInRaw = normalize(rawText).includes(compact(batch));
  if (!presentInRaw) {
    return checkStatus('review', 'Batch number', `Batch "${batch}" was provided but not found in the recognized text — confirm it.`);
  }
  return checkStatus('pass', 'Batch number', `Batch "${batch}" appears in the recognized text.`);
}

function manufacturerCheck(fields) {
  const manufacturer = fields?.manufacturer;
  const entry = manufacturer ? manufacturerCatalogEntry(manufacturer) : null;
  if (!manufacturer) {
    return checkStatus('unavailable', 'Manufacturer', 'Not found in the recognized text — cannot check.');
  }
  if (!entry) {
    return checkStatus('unavailable', 'Manufacturer', `"${manufacturer}" is not in the reference manufacturer list.`);
  }
  const names = entry.products.map(p => normalize(p.name)).filter(Boolean);
  if (names.length === 0) {
    return checkStatus('pass', 'Manufacturer', `${entry.manufacturer} is in the reference manufacturer list.`);
  }
  return checkStatus('pass', 'Manufacturer', `${entry.manufacturer} is in the reference list with ${names.length} known product${names.length === 1 ? '' : 's'}.`);
}

function brandCheck(fields, rawText) {
  const brand = fields?.brand;
  if (!brand) {
    return checkStatus('unavailable', 'Brand name', 'Not found in the recognized text — cannot check.');
  }
  const match = bestReferenceEntry(brand);
  if (!match) {
    return checkStatus('review', 'Brand name', `"${brand}" is not in the reference product list — verify with a pharmacist.`);
  }
  const entry = match.entry;
  const dosageForm = fields?.dosageForm ? normalize(fields.dosageForm) : null;
  const forms = (match.product.dosageForms ?? []).map(normalize);
  const formOk = !dosageForm || forms.length === 0 || forms.some(f => dosageForm.includes(f) || f.includes(dosageForm));
  if (!formOk) {
    return checkStatus(
      'review',
      'Brand name',
      `"${brand}" matches ${match.product.name} by ${entry.manufacturer}, but the dosage form "${fields.dosageForm}" differs from the reference (${forms.join(', ')}).`
    );
  }
  const inText = compact(rawText).includes(compact(match.product.name));
  if (!inText) {
    return checkStatus(
      'review',
      'Brand name',
      `"${brand}" matches ${match.product.name} by ${entry.manufacturer} in reference data, but the name was not found in the recognized text.`
    );
  }
  return checkStatus('pass', 'Brand name', `"${brand}" matches ${match.product.name} by ${entry.manufacturer} in the reference list.`);
}

function compositionCheck(fields, rawText) {
  const composition = fields?.composition;
  if (!composition) {
    return checkStatus('unavailable', 'Composition', 'Not found in the recognized text — cannot check.');
  }
  const stated = ingredientFacts(String(composition));
  const inText = ingredientFacts(String(rawText));
  if (stated.length === 0) {
    return checkStatus('review', 'Composition', `Composition "${composition}" contains no readable ingredient-with-strength fact.`);
  }
  const missing = stated.filter(ing => {
    const namePart = normalize(ing).replace(/\s*\d.*$/, '').trim();
    const strength = compact(ing).match(/(\d+(?:\.\d+)?)(mg|mcg|g|ml|iu)/);
    return !inText.some(other => {
      if (strength && !compact(other).includes(strength[0])) return false;
      return !namePart || normalize(other).includes(namePart) || namePart.includes(normalize(other).replace(/\s*\d.*$/, '').trim());
    });
  });
  if (missing.length === stated.length) {
    return checkStatus('review', 'Composition', `None of the stated ingredients (${stated.join(', ')}) appear in the recognized text.`);
  }
  if (missing.length > 0) {
    return checkStatus('review', 'Composition', `${missing.join(', ')} not found in the recognized text — confirm the pack.`);
  }
  return checkStatus('pass', 'Composition', `Stated composition (${stated.join(', ')}) appears in the recognized text.`);
}

function licenceCheck(fields, rawText) {
  const licence = fields?.mfgLicence ?? fields?.licence;
  const compactRaw = compact(rawText);
  const licencePattern = /\b([a-z]{1,3}\/\d{2,4}\/\d{2,4}|\d{2,3}\/[a-z]{1,3}\/\d{2,4})\b/i;
  const printed = rawText.match(licencePattern);
  if (licence) {
    const ok = compactRaw.includes(compact(licence));
    return ok
      ? checkStatus('pass', 'Mfg licence', `Licence ${licence} appears in the recognized text.`)
      : checkStatus('review', 'Mfg licence', `Licence ${licence} was provided but not found in the recognized text.`);
  }
  if (printed) {
    return checkStatus('pass', 'Mfg licence', `Licence ${printed[1]} found in the recognized text.`);
  }
  return checkStatus('unavailable', 'Mfg licence', 'No manufacturing licence number found — optional check.');
}

// ---------------------------------------------------------------------------
// Reference-record enrichment (About this medicine + field fallbacks)
// ---------------------------------------------------------------------------

function fromReferenceFor(fields) {
  const brandCandidates = [fields?.brand, fields?.composition && null].filter(Boolean);
  let info = null;
  for (const candidate of brandCandidates) {
    info = infoForBrand(candidate);
    if (info) break;
  }
  if (!info && fields?.composition) {
    // Identified via formula/brand: match by ingredient keywords.
    const compNorm = normalize(fields.composition);
    for (const candidate of REFERENCE_INFO) {
      const keywords = (candidate.ingredients ?? []).flatMap(i => i.keywords ?? []).map(normalize).filter(Boolean);
      const hits = keywords.filter(k => compNorm.includes(k)).length;
      if (hits > 0 && (!info || hits > info._hits)) info = { ...candidate, _hits: hits };
    }
    if (info) delete info._hits;
  }
  return info;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * @param {typeof REFERENCE_PRODUCTS} referenceProducts
 * @returns {(input: { rawText: string, fields: { batch?, mfg?, exp?, manufacturer?, brand?, composition?, dosageForm?, mfgLicence? } }) => {
 *   label: string,
 *   confidence: 'high' | 'medium' | 'low',
 *   riskLevel: 'consistent' | 'needs-review' | 'high-risk',
 *   counts: { passed: number, failed: number, review: number, unavailable: number },
 *   checks: Array<{ name: string, status: 'pass' | 'fail' | 'review' | 'unavailable', reason: string }>,
 *   fromReference: null | { brand, composition, dosageForm, drugClass, manufacturer, licenseNo, uses, sideEffects, warnings, disclaimer },
 *   rawTextLength: number,
 * }}
 */
export function createVerifier(referenceProducts = REFERENCE_PRODUCTS) {
  // referenceProducts is accepted for parity with the spec signature
  // createVerifier(products); the checks read the module-level reference data.
  const catalog = referenceProducts ?? [];
  void catalog;

  return function verify({ rawText = '', fields = {} } = {}) {
    const text = String(rawText ?? '');
    const now = new Date();

    const checks = [
      brandCheck(fields, text),
      compositionCheck(fields, text),
      expiryCheck(fields, now),
      batchCheck(fields, text),
      manufacturerCheck(fields),
      licenceCheck(fields, text),
    ];

    const counts = {
      passed: checks.filter(c => c.status === 'pass').length,
      failed: checks.filter(c => c.status === 'fail').length,
      review: checks.filter(c => c.status === 'review').length,
      unavailable: checks.filter(c => c.status === 'unavailable').length,
    };

    let label;
    let confidence;
    let riskLevel;
    if (counts.failed >= 2) {
      label = 'High Risk';
      confidence = 'high';
      riskLevel = 'high-risk';
    } else if (counts.failed === 1) {
      label = 'High Risk';
      confidence = 'medium';
      riskLevel = 'high-risk';
    } else if (counts.review > 0) {
      label = 'Needs Review';
      confidence = counts.unavailable >= 3 ? 'low' : 'medium';
      riskLevel = 'needs-review';
    } else {
      label = 'Consistent';
      confidence = counts.unavailable > 0 ? 'medium' : 'high';
      riskLevel = 'consistent';
    }

    const info = fromReferenceFor(fields);
    const fromReference = info
      ? {
          brand: info.brand,
          composition: (info.ingredients ?? [])
            .map(i => `${i.name} ${i.strengthMg}mg`)
            .join(' + '),
          dosageForm: info.dosageForm,
          drugClass: info.drugClass,
          manufacturer: info.manufacturerDisplay,
          licenseNo: info.licenseNo,
          uses: info.uses,
          sideEffects: info.sideEffects ?? [],
          warnings: info.warnings ?? [],
          disclaimer:
            'Reference information only — this does NOT verify chemical content. Consult a pharmacist or doctor.',
        }
      : null;

    return { label, confidence, riskLevel, counts, checks, fromReference, rawTextLength: text.length };
  };
}

export default createVerifier;
