import type { BatchInfoResult, CheckResult, DecodedCode, ExtractedData, RiskLevel } from '../types';
import { findCatalogEntry } from '../services/extract';
import { lookupBatchInfo } from '../services/identify';
import { parseCodePayload } from '../services/barcode';
import { parseMonthYear } from './helpers';

/**
 * Run all checks against the merged session data. Missing/unreadable data is
 * never a "fail" — it is "review" or "unavailable", and it lowers confidence.
 * "fail" requires a positive contradiction (e.g. a past expiry date).
 */
export function runChecks(data: ExtractedData): CheckResult[] {
  const checks: CheckResult[] = [];
  const f = data.fields;

  // --- Package detection: keyword-based; 0-2 hits = review, never fail ----
  if (!data.usable) {
    checks.push({
      id: 'usability',
      name: 'Package Detection',
      status: 'review',
      reason:
        data.rejectReason ??
        'Could not read enough text to identify a medicine package. Add a clearer photo or enter details manually.',
    });
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
        reason: expired
          ? 'Expired - do not use'
          : f.expiry_date.origin === 'user'
            ? `Valid until end of ${parsed.month}/${parsed.year} (entered by user).`
            : `Valid until end of ${parsed.month}/${parsed.year}.`,
      });
    }
  } else {
    checks.push({
      id: 'expiry',
      name: 'Expiry Date',
      status: 'review',
      reason: NOT_VISIBLE_HINT,
    });
  }

  // --- Batch: review if missing, never fail for being missing -------------
  if (f.batch_no) {
    checks.push({
      id: 'batch',
      name: 'Batch Number',
      status: 'pass',
      reason: `Batch ${f.batch_no.value} ${describeOrigin(f.batch_no)}.`,
    });
  } else {
    checks.push({
      id: 'batch',
      name: 'Batch Number',
      status: 'review',
      reason: NOT_VISIBLE_HINT,
    });
  }

  // --- Manufacturer: unavailable/review when unknown, no catalog guessing -
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
        checks.push({
          id: 'company-product',
          name: 'Company-Product Consistency',
          status: 'pass',
          reason: `${entry.manufacturer} lists ${product.name} in reference data.`,
        });
      }
    }
  }

  // --- Visual template: no template dataset exists -------------------------
  checks.push({
    id: 'visual-template',
    name: 'Visual Template Match',
    status: 'unavailable',
    reason: 'No packaging template for this product is available to compare against.',
  });

  // --- Text readability ----------------------------------------------------
  const lowConfidenceLines = data.rawTextLines.filter(l => l.confidence === 'low').length;
  if (lowConfidenceLines > 0) {
    checks.push({
      id: 'readability',
      name: 'Text Readability',
      status: 'review',
      reason: `${lowConfidenceLines} line${lowConfidenceLines === 1 ? '' : 's'} were read with low confidence.`,
    });
  } else if (data.rawTextLines.length > 0) {
    checks.push({
      id: 'readability',
      name: 'Text Readability',
      status: 'pass',
      reason: 'All detected text was read with usable confidence.',
    });
  }

  // --- Image quality -------------------------------------------------------
  if (data.blurScore > 0 && data.blurScore < 0.003) {
    checks.push({
      id: 'image-quality',
      name: 'Image Quality',
      status: 'review',
      reason: 'The image appears blurry — extracted values may be inaccurate.',
    });
  }

  checks.push(...runCodeChecks(data.fields, data.codes));
  checks.push(...runBatchInfoCheck(data.fields));

  return checks;
}

/**
 * Code checks: "Code readable" (pass/unavailable only — no code is never a
 * fail) and a cross-check of any GS1 batch/expiry against the OCR reads.
 * A decoded code NEVER proves authenticity on its own.
 */
export function runCodeChecks(fields: ExtractedData['fields'], codes: DecodedCode[]): CheckResult[] {
  const checks: CheckResult[] = [];
  if (codes.length === 0) {
    checks.push({
      id: 'code-readable',
      name: 'Code Readable',
      status: 'unavailable',
      reason: 'No QR, DataMatrix or 1D barcode could be decoded from the image. Not every pack carries one.',
    });
    return checks;
  }

  const primary = codes[0];
  checks.push({
    id: 'code-readable',
    name: 'Code Readable',
    status: 'pass',
    reason: `${primary.format} code decoded${codes.length > 1 ? ` (+${codes.length - 1} more)` : ''}. A readable code does NOT prove authenticity — copied codes exist.`,
  });

  // Cross-check any batch/expiry inside a GS1 payload against the OCR text.
  const gs1 = codes
    .map(c => parseCodePayload(c.payload))
    .find(p => p.kind === 'gs1');
  if (!gs1) return checks;

  const ocrBatch = fields.batch_no?.value;
  if (gs1.batch && ocrBatch) {
    const match = ocrBatch.replace(/[^A-Za-z0-9]/g, '').toUpperCase() === gs1.batch.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    checks.push({
      id: 'code-batch-match',
      name: 'Code vs Printed Batch',
      status: match ? 'pass' : 'fail',
      reason: match
        ? `Batch on the pack (${ocrBatch}) matches the code.`
        : 'Printed batch differs from the code.',
    });
  }
  const ocrExpiry = fields.expiry_date?.value;
  if (gs1.expiry && ocrExpiry) {
    const parsedOcr = parseMonthYear(ocrExpiry);
    const match =
      parsedOcr !== null &&
      parsedOcr.month === Number(gs1.expiry.slice(0, 2)) &&
      parsedOcr.year === Number(gs1.expiry.slice(3, 7));
    checks.push({
      id: 'code-expiry-match',
      name: 'Code vs Printed Expiry',
      status: match ? 'pass' : 'fail',
      reason: match
        ? `Expiry on the pack (${ocrExpiry}) matches the code.`
        : 'Printed expiry differs from the code.',
    });
  }
  return checks;
}

/**
 * Batch information panel as checks: reference lookup + pattern format check.
 * Never infers a medicine type or category from the batch number.
 */
export function runBatchInfoCheck(fields: ExtractedData['fields']): CheckResult[] {
  const batchField = fields.batch_no;
  if (!batchField) return [];
  const info: BatchInfoResult = lookupBatchInfo(batchField.value, fields.manufacturer_name?.value ?? fields.marketer_name?.value);

  const checks: CheckResult[] = [];
  if (info.reference) {
    const r = info.reference;
    checks.push({
      id: 'batch-reference',
      name: 'Batch Reference Data',
      status: 'pass',
      reason: `Batch ${r.batch} of ${r.product} (${r.manufacturer}) is in reference data${r.mfg ? `, mfg ${r.mfg}` : ''}${r.exp ? `, exp ${r.exp}` : ''}${r.source ? `, source: ${r.source}` : ''}.`,
    });
  } else {
    checks.push({
      id: 'batch-reference',
      name: 'Batch Reference Data',
      status: 'unavailable',
      reason: `Batch ${batchField.value} not in reference data. Cannot be verified.`,
    });
  }

  if (info.formatCheck) {
    checks.push({
      id: 'batch-format',
      name: 'Batch Format',
      status: info.formatCheck.status === 'pass' ? 'pass' : info.formatCheck.status === 'fail' ? 'review' : 'unavailable',
      reason: info.formatCheck.detail,
    });
  }
  return checks;
}

const NOT_VISIBLE_HINT =
  'Not visible in this image. Batch and expiry are usually printed on the crimped edge or the outer carton. Photograph that area.';

function describeOrigin(field: { origin: 'image' | 'user'; confidence: string }): string {
  if (field.origin === 'user') return 'was entered by user';
  return `was read from the image (${field.confidence} confidence)`;
}

/** A month is expired if the last day of that month is before today. */
export function isPastMonth(parsed: { month: number; year: number }): boolean {
  const endOfMonth = new Date(parsed.year, parsed.month, 0, 23, 59, 59);
  return endOfMonth.getTime() < Date.now();
}

/**
 * Overall result from check counts only: high-risk needs 2+ independent fails.
 * Missing data (review/unavailable) yields needs-review, never fail.
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

/** 0-100 evidence strength: reads + user entries + skips, from real signals. */
export function computeScanQuality(
  data: ExtractedData,
  skippedCount = 0,
  userEnteredCount = 0
): number {
  const blurFactor = Math.min(1, data.blurScore / 0.02);
  const lineFactor = Math.min(1, data.rawTextLines.length / 12);
  const highConf = data.rawTextLines.filter(l => l.confidence === 'high').length;
  const confFactor = data.rawTextLines.length > 0 ? highConf / data.rawTextLines.length : 0;
  const skipPenalty = Math.min(0.3, skippedCount * 0.1);
  const userBonus = Math.min(0.15, userEnteredCount * 0.05);
  const base = 0.4 * blurFactor + 0.3 * lineFactor + 0.3 * confFactor;
  return Math.max(0, Math.round(100 * (base - skipPenalty + userBonus)));
}
