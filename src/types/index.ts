export type RiskLevel = 'consistent' | 'needs-review' | 'high-risk';

export type CaptureSource = 'camera' | 'upload';

export type FieldOrigin = 'image' | 'user';

/** Where one extracted value came from. */
export interface FieldProvenance {
  /** The photo (session photo id) the value was read from. */
  photoId?: string;
  /** Region of that photo the value was read from, in that photo's pixels. */
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  /** The exact OCR text that matched. */
  matchedText?: string;
  /** Which orientation/variant read it (for debugging). */
  runLabel?: string;
}

/** A single extracted value with confidence and provenance. */
export interface ExtractionField {
  value: string;
  confidence: 'high' | 'medium' | 'low';
  /** 'image' = read from a photo; 'user' = typed manually (lower-confidence evidence). */
  origin: FieldOrigin;
  provenance?: FieldProvenance;
}

export type FieldKey =
  | 'brand_name'
  | 'composition'
  | 'dosage_form'
  | 'manufacturer_name'
  | 'marketer_name'
  | 'manufacturing_license_no'
  | 'batch_no'
  | 'mfg_date'
  | 'expiry_date'
  | 'mrp'
  | 'schedule_marking'
  | 'qr_or_barcode_present'
  | 'pill_imprint';

export type ExtractedFields = Record<FieldKey, ExtractionField | null>;

export type BBox = { x0: number; y0: number; x1: number; y1: number };

/** A line of text found on the pack, with its position and source. */
export interface TextLine {
  text: string;
  bbox: BBox;
  /** 1-based band index the line came from (0 = full-image pass). */
  band: number;
  confidence: 'high' | 'medium' | 'low';
  /** Mean word confidence (0-100) from tesseract for filtering/debugging. */
  wordConfidence?: number;
  /** Which orientation/variant run found it. */
  runLabel?: string;
  /** Field names this line fed (filled by extraction). */
  fields?: string[];
  /** Which orientation pass found it: 0 = upright, 1 = rotated 90°, 2 = rotated 270°. */
  orientation?: 0 | 1 | 2;
}

export interface UnreadableRegion {
  bbox: BBox;
  text: string;
  confidence: number;
}

/** A QR/DataMatrix/1D code decoded from the pack image. */
export interface DecodedCode {
  /** Raw decoded payload (untrusted — never auto-opened). */
  payload: string;
  /** 'QR_CODE' | 'DATA_MATRIX' | 'EAN_13' | 'CODE_128' | ... */
  format: string;
  /** Which decoder found it. */
  source: 'native-detector' | 'zxing';
  /** Position on the image, when the decoder provides one. */
  bbox?: BBox;
}

export type IdentificationMethod =
  | 'code-gtin'
  | 'code-url'
  | 'composition'
  | 'fuzzy-brand'
  | 'pill'
  | 'user';

/** Result of the identification fallback chain. */
export interface Identification {
  method: IdentificationMethod;
  confidence: 'high' | 'medium' | 'low';
  /** Product name suggested by the method, when it provides one. */
  productName?: string;
  detail: string;
}

/** Drug-class info derived from the composition only (never from batch). */
export interface DrugClassInfo {
  classes: string[];
  matchedIngredients: string[];
}

/** An entry of data/batches.json. */
export interface BatchReference {
  batch: string;
  product: string;
  manufacturer: string;
  mfg?: string;
  exp?: string;
  source?: string;
  status?: string;
}

/** Batch info panel data: reference lookup + format check. */
export interface BatchInfoResult {
  batch: string;
  reference: BatchReference | null;
  formatCheck: { status: 'pass' | 'fail' | 'unknown'; detail: string } | null;
}

export interface ExtractedData {
  usable: boolean;
  /** Why the image was rejected as a medicine pack. */
  rejectReason?: string;
  /** How many medicine keywords the text contained. */
  keywordHits: number;
  fields: ExtractedFields;
  rawTextLines: TextLine[];
  unreadableRegions: UnreadableRegion[];
  blurScore: number;
  /** QR/barcodes decoded from the image (client-side, both analyzer paths). */
  codes: DecodedCode[];
}

export interface CheckResult {
  id: string;
  name: string;
  status: 'pass' | 'fail' | 'review' | 'unavailable';
  reason: string;
}

/** A photo captured during a scan session. */
export interface SessionPhoto {
  id: string;
  /** Data URL (downscaled JPEG) kept in memory only. */
  dataUrl: string;
  label: string;
  addedAt: string;
}

export interface ScanResult {
  id: string;
  /** ISO date-time string so the object survives JSON serialization. */
  timestamp: string;
  /** Thumbnail data URL. */
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
  /** Photos and manual entries collected during the session. */
  photos: SessionPhoto[];
  /** Field keys the user skipped collecting (lowers confidence). */
  skippedFields: FieldKey[];
  /** Fields the user typed or corrected manually. */
  userEnteredFields: FieldKey[];
  /** How the product was identified (fallback chain), when any method worked. */
  identification: Identification | null;
  /** Class info derived from the composition, when ingredients matched. */
  drugClass: DrugClassInfo | null;
  /** Batch reference-data lookup + format check, when a batch was read. */
  batchInfo: BatchInfoResult | null;
}

export type Screen = 'scan' | 'results' | 'history' | 'settings' | 'collect';

export type AppSettings = {
  language: string;
  theme: 'light' | 'dark' | 'system';
  reducedMotion: boolean;
  highContrast: boolean;
  largeText: boolean;
  hapticFeedback: boolean;
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
  analytics: false,
  notifications: true,
};

/** Keys whose absence blocks the final verdict (STEP 1 of collection flow). */
export const BLOCKING_KEYS: FieldKey[] = ['batch_no', 'expiry_date', 'manufacturer_name'];

/** The ordered collection steps: groups of fields to capture per instruction. */
export const COLLECTION_STEPS: Array<{
  id: string;
  title: string;
  instruction: string;
  keys: FieldKey[];
}> = [
  {
    id: 'crimp',
    title: 'Batch, MFG, EXP & MRP',
    instruction:
      'Photograph the crimped edge or side of the strip, or the outer box flap. Rotate the strip if the text runs sideways.',
    keys: ['batch_no', 'mfg_date', 'expiry_date', 'mrp'],
  },
  {
    id: 'company',
    title: 'Manufacturer & licence',
    instruction: 'Photograph the back of the strip or the side of the carton.',
    keys: ['manufacturer_name', 'marketer_name', 'manufacturing_license_no'],
  },
  {
    id: 'pill',
    title: 'Pill check (optional)',
    instruction: 'Photograph the tablet on a plain background.',
    keys: ['pill_imprint'],
  },
];
