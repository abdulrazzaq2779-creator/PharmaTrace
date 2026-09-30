import type { ExtractedFields, RiskLevel } from '../types';

export const riskLevelLabels: Record<RiskLevel, string> = {
  consistent: 'Consistent with available evidence',
  'needs-review': 'Needs Review',
  'high-risk': 'High Risk',
};

export const riskLevelDescriptions: Record<RiskLevel, string> = {
  consistent:
    'Checks that returned data did not contradict each other. This is NOT a guarantee of genuineness.',
  'needs-review':
    'Important signals are missing, unreadable, or need a pharmacist to review.',
  'high-risk': 'Two or more independent checks failed.',
};

export const disclaimerText =
  'PharmaTrace reads the text on a package with OCR and checks it for internal consistency. It cannot verify what is chemically inside a pill. This is a screening aid only — not a medical device, not medical advice. For urgent needs contact a clinician, pharmacist, or emergency service.';

export const emergencyWarning =
  'Not for emergency use. Contact a clinician, pharmacist, or emergency service.';

export const APP_VERSION = '1.1.0';

/** Human labels for extracted fields, in display order. */
export const FIELD_LABELS: Array<{ key: keyof ExtractedFields; label: string; mono?: boolean }> = [
  { key: 'brand_name', label: 'Brand Name' },
  { key: 'composition', label: 'Composition' },
  { key: 'dosage_form', label: 'Dosage Form' },
  { key: 'manufacturer_name', label: 'Manufacturer' },
  { key: 'marketer_name', label: 'Marketer' },
  { key: 'manufacturing_license_no', label: 'Mfg. License No.', mono: true },
  { key: 'batch_no', label: 'Batch No.', mono: true },
  { key: 'mfg_date', label: 'Mfg. Date', mono: true },
  { key: 'expiry_date', label: 'Expiry Date', mono: true },
  { key: 'mrp', label: 'MRP', mono: true },
  { key: 'schedule_marking', label: 'Schedule Marking' },
  { key: 'qr_or_barcode_present', label: 'QR / Barcode' },
  { key: 'pill_imprint', label: 'Pill Imprint' },
];
