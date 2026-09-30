import type { FieldKey, ScanResult } from '../types';
import { FIELD_LABELS, riskLevelLabels } from '../data/content';

export function buildReportText(scan: ScanResult): string {
  return buildTextReportImpl(scan);
}

function buildTextReportImpl(scan: ScanResult): string {
  const f = scan.extractedData.fields;
  const lines: string[] = [
    'PharmaTrace Scan Report',
    '=======================',
    `Verdict: ${riskLevelLabels[scan.riskLevel]}`,
    `Analyzer: ${scan.analyzer}`,
    `Scanned: ${new Date(scan.timestamp).toLocaleString()}`,
    '',
    'Extracted fields:',
  ];

  for (const { key, label } of FIELD_LABELS as Array<{ key: FieldKey; label: string }>) {
    const field = f[key];
    if (!field) {
      lines.push(`- ${label}: Not found`);
      continue;
    }
    const origin = field.origin === 'user' ? ' (entered by user)' : '';
    lines.push(`- ${label}: ${field.value}${origin} [${field.confidence}]`);
  }

  if (scan.photos.length > 1) {
    lines.push('', `Photos used: ${scan.photos.length}`);
    for (const photo of scan.photos) lines.push(`- ${photo.label}`);
  }
  if (scan.userEnteredFields.length > 0) {
    lines.push('', `Typed by user: ${scan.userEnteredFields.join(', ')}`);
  }
  if (scan.skippedFields.length > 0) {
    lines.push('', `Skipped (lowers confidence): ${scan.skippedFields.join(', ')}`);
  }

  lines.push('', 'Checks:');
  for (const check of scan.checks) {
    lines.push(`- [${check.status.toUpperCase()}] ${check.name}: ${check.reason}`);
  }

  lines.push(
    '',
    'Missing data lowered the confidence where applicable.',
    'Screening aid only — this does NOT verify chemical content.'
  );
  return lines.join('\n');
}
