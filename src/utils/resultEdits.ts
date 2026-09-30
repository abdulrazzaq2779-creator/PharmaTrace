import type { ExtractionField, FieldKey, ScanResult } from '../types';
import { computeOverall, computeScanQuality, runChecks } from './checks';
import { classifyComposition, identifyProduct, lookupBatchInfo } from '../services/identify';

/**
 * Apply a user-entered value to a finished result and recompute checks,
 * risk, identification and drug-class info. Values are marked "entered by
 * user" and count as lower-confidence evidence.
 */
export function applyManualEntry(scan: ScanResult, key: FieldKey, value: string): ScanResult | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const field: ExtractionField = { value: trimmed, confidence: 'low', origin: 'user' };
  const fields = { ...scan.extractedData.fields, [key]: field };
  const data = { ...scan.extractedData, fields };
  const checks = runChecks(data);
  const userEnteredFields = scan.userEnteredFields.includes(key)
    ? scan.userEnteredFields
    : [...scan.userEnteredFields, key];

  return {
    ...scan,
    extractedData: data,
    checks,
    riskLevel: computeOverall(checks),
    scanQuality: computeScanQuality(data, scan.skippedFields.length, userEnteredFields.length),
    userEnteredFields,
    identification: identifyProduct(
      fields,
      data.codes,
      data.rawTextLines,
      key === 'brand_name' ? trimmed : scan.identification?.method === 'user' ? scan.identification.productName : undefined
    ),
    drugClass: classifyComposition(fields.composition?.value),
    batchInfo: fields.batch_no
      ? lookupBatchInfo(fields.batch_no.value, fields.manufacturer_name?.value ?? fields.marketer_name?.value)
      : null,
  };
}
