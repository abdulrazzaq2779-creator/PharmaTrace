import type { CheckResult, ExtractedData, RiskLevel } from '../types';
import { findCatalogEntry } from '../services/extract';
import { parseMonthYear } from './helpers';

/**
 * Run all checks against REAL extracted data. Every check states its reason;
 * nothing is inferred beyond what was read from the pack.
 */
export function runChecks(data: ExtractedData): CheckResult[] {
  const checks: CheckResult[] = [];
  const f = data.fields;

  if (!data.usable) {
    return [
      {
        id: 'usability',
        name: 'Medicine Package Detected',
        status: 'fail',
        reason: data.rejectReason ?? 'The image does not appear to be a medicine package.',
      },
    ];
  }

  // --- Expiry: fail only if actually past ---------------------------------
  if (f.expiry_date) {
    const parsed = parseMonthYear(f.expiry_date.value);
    if (!parsed) {
      checks.push({
        id: 'expiry',
        name: 'Expiry Date',
        status: 'review',
        reason: `Expiry "${f.expiry_date.value}" was read but could not be interpreted as a date.`,
      });
    } else {
      const expired = isPastMonth(parsed);
      checks.push({
        id: 'expiry',
        name: 'Expiry Date',
        status: expired ? 'fail' : 'pass',
        reason: expired ? 'Expired - do not use' : `Valid until end of ${parsed.month}/${parsed.year}.`,
      });
    }
  } else {
    checks.push({
      id: 'expiry',
      name: 'Expiry Date',
      status: 'unavailable',
      reason: 'No expiry date was readable on the pack.',
    });
  }

  // --- Batch: review if missing, never fail for being missing -------------
  if (f.batch_no) {
    checks.push({
      id: 'batch',
      name: 'Batch Number',
      status: 'pass',
      reason: `Batch ${f.batch_no.value} was read (${f.batch_no.confidence} confidence).`,
    });
  } else {
    checks.push({
      id: 'batch',
      name: 'Batch Number',
      status: 'review',
      reason: 'Batch number missing or unreadable — verify against the physical pack.',
    });
  }

  // --- Company-product: catalog lookup, fail only on real contradiction ---
  const brand = f.brand_name?.value;
  const manufacturer = f.manufacturer_name?.value ?? f.marketer_name?.value;
  if (!brand || !manufacturer) {
    checks.push({
      id: 'company-product',
      name: 'Company-Product Consistency',
      status: 'unavailable',
      reason: 'Brand or manufacturer was not readable, so the pair cannot be checked.',
    });
  } else {
    const entry = findCatalogEntry(manufacturer);
    if (!entry) {
      checks.push({
        id: 'company-product',
        name: 'Company-Product Consistency',
        status: 'unavailable',
        reason: `"${manufacturer}" is not in reference data.`,
      });
    } else {
      const product = entry.products.find(p => p.name.toLowerCase() === brand.toLowerCase());
      if (!product) {
        checks.push({
          id: 'company-product',
          name: 'Company-Product Consistency',
          status: 'review',
          reason: `"${brand}" is not listed under ${entry.manufacturer} in reference data — verify with a pharmacist.`,
        });
      } else {
        // If a composition was read, check for a real contradiction with the catalog.
        const composition = f.composition?.value ?? '';
        const compositionContradicts =
          composition !== '' &&
          !product.name.toLowerCase().includes(composition.toLowerCase().split(/[\s+/]/)[0].toLowerCase()) &&
          !composition.toLowerCase().includes(product.name.toLowerCase());

        checks.push({
          id: 'company-product',
          name: 'Company-Product Consistency',
          status: compositionContradicts ? 'review' : 'pass',
          reason: compositionContradicts
            ? `Composition "${composition}" does not match reference data for ${product.name}.`
            : `${entry.manufacturer} lists ${product.name} in reference data.`,
        });
      }
    }
  }

  // --- Visual template check: no template dataset exists -------------------
  checks.push({
    id: 'visual-template',
    name: 'Visual Template Match',
    status: 'unavailable',
    reason: 'No packaging template for this product is available to compare against.',
  });

  // --- Text readability: low OCR confidence surfaces as review ------------
  const lowConfidenceLines = data.rawTextLines.filter(l => l.confidence === 'low').length;
  if (lowConfidenceLines > 0) {
    checks.push({
      id: 'readability',
      name: 'Text Readability',
      status: 'review',
      reason: `${lowConfidenceLines} line${lowConfidenceLines === 1 ? '' : 's'} were read with low confidence — rescan in better light for a firmer result.`,
    });
  } else if (data.rawTextLines.length > 0) {
    checks.push({
      id: 'readability',
      name: 'Text Readability',
      status: 'pass',
      reason: 'All detected text was read with usable confidence.',
    });
  }

  // --- Image quality: blur -----------------------------------------------
  if (data.blurScore > 0 && data.blurScore < 0.003) {
    checks.push({
      id: 'image-quality',
      name: 'Image Quality',
      status: 'review',
      reason: 'The image appears blurry — extracted values may be inaccurate.',
    });
  }

  return checks;
}

/** A month is expired if the last day of that month is before today. */
export function isPastMonth(parsed: { month: number; year: number }): boolean {
  const endOfMonth = new Date(parsed.year, parsed.month, 0, 23, 59, 59);
  return endOfMonth.getTime() < Date.now();
}

/**
 * Overall risk derived ONLY from check results:
 * high-risk requires 2+ independent fails; any single fail or review yields
 * needs-review; consistent otherwise. This is never a genuineness guarantee.
 */
export function computeOverall(checks: CheckResult[]): RiskLevel {
  const fails = checks.filter(c => c.status === 'fail').length;
  const reviews = checks.filter(c => c.status === 'review').length;
  if (fails >= 2) return 'high-risk';
  if (fails === 1 || reviews > 0) return 'needs-review';
  return 'consistent';
}

export function countStatuses(checks: CheckResult[]) {
  return {
    passed: checks.filter(c => c.status === 'pass').length,
    failed: checks.filter(c => c.status === 'fail').length,
    review: checks.filter(c => c.status === 'review').length,
    unavailable: checks.filter(c => c.status === 'unavailable').length,
  };
}

/** 0-100 quality score from real signals: blur, line count, confidence mix. */
export function computeScanQuality(data: ExtractedData): number {
  const blurFactor = Math.min(1, data.blurScore / 0.02); // saturate at healthy variance
  const lineFactor = Math.min(1, data.rawTextLines.length / 12);
  const highConf = data.rawTextLines.filter(l => l.confidence === 'high').length;
  const confFactor = data.rawTextLines.length > 0 ? highConf / data.rawTextLines.length : 0;
  return Math.round(100 * (0.4 * blurFactor + 0.3 * lineFactor + 0.3 * confFactor));
}
