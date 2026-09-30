/**
 * Renders ResultsScreen with a realistic fixture (values from the verified
 * Amlokind AT lab scan) so the new panels can be screenshot-tested without
 * running OCR in the browser.
 */
import { createRoot } from 'react-dom/client';
import { ResultsScreen } from '../src/screens/ResultsScreen';
import '../src/index.css';
import type { ScanResult } from '../src/types';

const lines = [
  { text: 'AMLOKIND-AT', bbox: { x0: 300, y0: 60, x1: 700, y1: 110 }, band: 0, confidence: 'high', wordConfidence: 91, runLabel: 'gray·0°·psm6', orientation: 0 as const, fields: ['brand_name'] },
  { text: 'Amlodipine 5mg + Atenolol 50mg', bbox: { x0: 200, y0: 140, x1: 800, y1: 180 }, band: 0, confidence: 'high', wordConfidence: 88, runLabel: 'gray·0°·psm6', orientation: 0 as const, fields: ['composition'] },
  { text: 'Mankind Pharma', bbox: { x0: 350, y0: 900, x1: 650, y1: 940 }, band: 0, confidence: 'medium', wordConfidence: 74, runLabel: 'thresh·0°·psm6', orientation: 0 as const, fields: ['manufacturer_name'] },
  { text: 'B.No G652046 MFG 04/2026 EXP 03/2028', bbox: { x0: 120, y0: 1150, x1: 880, y1: 1190 }, band: 0, confidence: 'medium', wordConfidence: 71, runLabel: 'gray·90°·psm6', orientation: 1 as const, fields: ['batch_no', 'mfg_date', 'expiry_date'] },
  { text: 'MRP Rs 95.00', bbox: { x0: 400, y0: 1220, x1: 620, y1: 1250 }, band: 0, confidence: 'low', wordConfidence: 55, runLabel: 'thresh·270°·psm11', orientation: 2 as const, fields: ['mrp'] },
];

const f = (value: string, confidence: 'high' | 'medium' | 'low', matchedText: string) => ({
  value,
  confidence,
  origin: 'image' as const,
  provenance: { matchedText, runLabel: 'gray·0°·psm6' },
});

const fixture: ScanResult = {
  id: 'fixture-0001',
  timestamp: new Date().toISOString(),
  imageUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1400"><rect width="1000" height="1400" fill="#e8eef4"/><rect x="100" y="80" width="800" height="1240" rx="24" fill="#f6f9fc" stroke="#b8c6d4" stroke-width="6"/><circle cx="780" cy="180" r="70" fill="none" stroke="#5a6b7a" stroke-width="10"/><rect x="710" y="110" width="140" height="140" fill="none" stroke="#5a6b7a" stroke-width="10" transform="rotate(12 780 180)"/></svg>'
  ),
  captureSource: 'upload',
  analyzer: 'tesseract',
  riskLevel: 'needs-review',
  extractedData: {
    usable: true,
    keywordHits: 9,
    fields: {
      brand_name: f('AMLOKIND-AT', 'high', 'AMLOKIND-AT'),
      composition: f('Amlodipine 5mg + Atenolol 50mg', 'high', 'Amlodipine 5mg + Atenolol 50mg'),
      dosage_form: f('tablet', 'medium', 'Tablets'),
      manufacturer_name: f('Mankind Pharma', 'medium', 'Mankind Pharma'),
      marketer_name: null,
      manufacturing_license_no: null,
      batch_no: f('G652046', 'medium', 'B.No G652046'),
      mfg_date: f('04/2026', 'medium', 'MFG 04/2026'),
      expiry_date: f('03/2028', 'medium', 'EXP 03/2028'),
      mrp: f('₹95.00', 'low', 'MRP Rs 95.00'),
      schedule_marking: f('Schedule H', 'high', 'Rx'),
      qr_or_barcode_present: null,
      pill_imprint: null,
    },
    rawTextLines: lines,
    unreadableRegions: [{ bbox: { x0: 400, y0: 1220, x1: 620, y1: 1250 }, text: 'MRP Rs 95.00', confidence: 55 }],
    blurScore: 0.012,
    codes: [
      { payload: '(01)08712345000012(10)G652046(17)280331(21)S98765', format: 'DATA_MATRIX', source: 'zxing' },
      { payload: 'https://verify.example-pharma.com/g/08712345000012', format: 'QR_CODE', source: 'native-detector' },
    ],
  },
  checks: [
    { id: 'expiry', name: 'Expiry Date', status: 'pass', reason: 'Valid until end of 3/2028.' },
    { id: 'batch', name: 'Batch Number', status: 'pass', reason: 'Batch G652046 was read from the image (medium confidence).' },
    { id: 'company-product', name: 'Company-Product Consistency', status: 'pass', reason: 'Mankind Pharma lists Amlokind AT in reference data.' },
    { id: 'visual-template', name: 'Visual Template Match', status: 'unavailable', reason: 'No packaging template for this product is available to compare against.' },
    { id: 'readability', name: 'Text Readability', status: 'review', reason: '1 line was read with low confidence.' },
    { id: 'code-readable', name: 'Code Readable', status: 'pass', reason: 'DATA_MATRIX code decoded (+1 more). A readable code does NOT prove authenticity — copied codes exist.' },
    { id: 'code-batch-match', name: 'Code vs Printed Batch', status: 'pass', reason: 'Batch on the pack (G652046) matches the code.' },
    { id: 'batch-reference', name: 'Batch Reference Data', status: 'pass', reason: 'Batch G652046 of Amlokind AT (Mankind Pharma) is in reference data, mfg 04/2026, exp 03/2028.' },
  ],
  scanQuality: 72,
  imageWidth: 1000,
  imageHeight: 1400,
  photos: [{ id: 'photo-1', dataUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#dde"/></svg>'), label: 'Front of pack', addedAt: new Date().toISOString() }],
  skippedFields: [],
  userEnteredFields: [],
  identification: {
    method: 'composition',
    confidence: 'high',
    productName: 'Amlokind AT',
    detail: 'Ingredients (amlodipine, atenolol) match Amlokind AT in reference data',
  },
  drugClass: {
    classes: ['Blood pressure (antihypertensive)'],
    matchedIngredients: ['amlodipine', 'atenolol'],
  },
  batchInfo: {
    batch: 'G652046',
    reference: {
      batch: 'G652046',
      product: 'Amlokind AT',
      manufacturer: 'Mankind Pharma',
      mfg: '04/2026',
      exp: '03/2028',
      source: 'Pack print verified during OCR lab test',
      status: 'reference',
    },
    formatCheck: { status: 'unknown', detail: 'No known batch pattern for this manufacturer — format cannot be checked.' },
  },
};

const root = createRoot(document.getElementById('root')!);
root.render(
  <ResultsScreen
    scanResult={fixture}
    onBack={() => {}}
    onRescan={() => {}}
    onShare={async () => 'copied'}
    onSaveReport={() => {}}
  />
);
