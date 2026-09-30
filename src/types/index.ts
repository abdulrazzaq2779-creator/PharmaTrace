export type RiskLevel = 'consistent' | 'needs-review' | 'high-risk';

export type CaptureSource = 'camera' | 'upload';

/** A line of text found on the pack, with its position and source. */
export interface TextLine {
  text: string;
  /** Bounding box in image pixel coordinates of the ORIGINAL image. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** 1-based band index the line came from (0 = full-image pass). */
  band: number;
  /** Confidence the text was read correctly. */
  confidence: 'high' | 'medium' | 'low';
  /** Field names this line fed (filled by extraction). */
  fields?: string[];
  /** Which orientation pass found it: 0 = upright, 1 = rotated 90°. */
  orientation?: 0 | 1;
}

export interface ExtractionField {
  value: string;
  confidence: 'high' | 'medium' | 'low';
  /** Which raw line(s) each value came from. */
  sourceLines: number;
}

export type ExtractedFields = {
  brand_name: ExtractionField | null;
  composition: ExtractionField | null;
  dosage_form: ExtractionField | null;
  manufacturer_name: ExtractionField | null;
  marketer_name: ExtractionField | null;
  manufacturing_license_no: ExtractionField | null;
  batch_no: ExtractionField | null;
  mfg_date: ExtractionField | null;
  expiry_date: ExtractionField | null;
  mrp: ExtractionField | null;
  schedule_marking: ExtractionField | null;
  qr_or_barcode_present: ExtractionField | null;
  pill_imprint: ExtractionField | null;
};

export interface ExtractedData {
  usable: boolean;
  /** Why the image was rejected as a medicine pack. */
  rejectReason?: string;
  fields: ExtractedFields;
  rawTextLines: TextLine[];
  unreadableRegions: Array<{ bbox: TextLine['bbox']; reason: string }>;
  /** Horizontal orientation pass results, merged in. */
  rotatedPassLines: TextLine[];
  blurScore: number;
}

export interface ScanResult {
  id: string;
  /** ISO date-time string so the object survives JSON serialization. */
  timestamp: string;
  /** Thumbnail data URL for history. */
  imageUrl: string;
  captureSource: CaptureSource;
  analyzer: 'vision-model' | 'tesseract';
  riskLevel: RiskLevel;
  extractedData: ExtractedData;
  checks: CheckResult[];
  /** 0-100, computed from real signals. */
  scanQuality: number;
  /** Decode dimensions the bboxes are relative to. */
  imageWidth: number;
  imageHeight: number;
}

export interface CheckResult {
  id: string;
  name: string;
  status: 'pass' | 'fail' | 'review' | 'unavailable';
  reason: string;
}

export interface ScanHistoryItem {
  id: string;
  date: string;
  productName: string;
  riskLevel: RiskLevel;
  thumbnail: string;
}

export type Screen = 'scan' | 'results' | 'history' | 'settings';

export type AppSettings = {
  language: string;
  theme: 'light' | 'dark' | 'system';
  reducedMotion: boolean;
  highContrast: boolean;
  largeText: boolean;
  hapticFeedback: boolean;
  autoSave: boolean;
  analytics: boolean;
  notifications: boolean;
};

export const defaultSettings: AppSettings = {
  language: 'en',
  theme: 'system',
  reducedMotion: false,
  highContrast: false,
  largeText: false,
  hapticFeedback: true,
  autoSave: true,
  analytics: false,
  notifications: true,
};
