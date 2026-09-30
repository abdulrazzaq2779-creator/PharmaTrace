/**
 * QR / DataMatrix / 1D barcode decoding.
 *
 * Strategy: the browser BarcodeDetector API where available (fast, gives a
 * bbox), otherwise (and additionally) a ZXing decode grid on grayscale
 * variants: full image + code-area crops, each at 0°/90°/270°.
 * Payloads are untrusted — this module only decodes, never opens anything.
 */
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from '@zxing/library';
import type { BBox, DecodedCode } from '../types';
import { grayscaleNormalized, rotateQuarter, upscaleForOcr } from '../utils/image';

/** Formats we care about on medicine packs. */
const WANTED_FORMATS = [
  'QR_CODE',
  'DATA_MATRIX',
  'EAN_13',
  'EAN_8',
  'CODE_128',
  'CODE_39',
  'ITF',
  'UPC_A',
  'UPC_E',
  'AZTEC',
] as const;

/** Map a native BarcodeDetector format string to a normalized name. */
function normalizeFormat(raw: string): string {
  // Native format is usually like 'qr_code', 'data_matrix', 'ean_13'.
  const upper = raw.toUpperCase();
  const match = WANTED_FORMATS.find(f => f === upper);
  return match ?? upper;
}

interface DetectedBarcode {
  rawValue: string;
  format: string;
  boundingBox?: { xMin: number; yMin: number; xMax: number; yMax: number };
}

/** Minimal shape of the (experimental) BarcodeDetector API. */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function getNativeDetector(): BarcodeDetectorCtor | null {
  const w = window as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
  return typeof w.BarcodeDetector === 'function' ? w.BarcodeDetector : null;
}

/** Decode via the browser's BarcodeDetector when present. */
async function detectNative(source: HTMLCanvasElement | HTMLVideoElement): Promise<DecodedCode[]> {
  const Ctor = getNativeDetector();
  if (!Ctor) return [];
  try {
    // Probe supported formats; skip formats the browser cannot handle.
    let formats: string[] | undefined;
    const detectorProto = (Ctor as unknown as { getSupportedFormats?: () => Promise<string[]> }).getSupportedFormats;
    if (typeof detectorProto === 'function') {
      const supported = new Set(await detectorProto.call(Ctor));
      formats = WANTED_FORMATS.map(f => f.toLowerCase()).filter(f => supported.has(f));
      if (formats.length === 0) return [];
    }
    const detector = new Ctor(formats ? { formats } : undefined);
    const found = await detector.detect(source);
    return found
      .filter(b => b.rawValue && b.rawValue.length > 0)
      .map(b => ({
        payload: b.rawValue,
        format: normalizeFormat(b.format),
        source: 'native-detector' as const,
        bbox: b.boundingBox
          ? {
              x0: b.boundingBox.xMin,
              y0: b.boundingBox.yMin,
              x1: b.boundingBox.xMax,
              y1: b.boundingBox.yMax,
            }
          : undefined,
      }));
  } catch {
    return [];
  }
}

const ZXING_FORMAT_IDS: Record<string, number> = {
  QR_CODE: BarcodeFormat.QR_CODE,
  DATA_MATRIX: BarcodeFormat.DATA_MATRIX,
  EAN_13: BarcodeFormat.EAN_13,
  EAN_8: BarcodeFormat.EAN_8,
  CODE_128: BarcodeFormat.CODE_128,
  CODE_39: BarcodeFormat.CODE_39,
  ITF: BarcodeFormat.ITF,
  UPC_A: BarcodeFormat.UPC_A,
  UPC_E: BarcodeFormat.UPC_E,
  AZTEC: BarcodeFormat.AZTEC,
};

function zxingFormatName(id: number): string {
  const entry = Object.entries(ZXING_FORMAT_IDS).find(([, v]) => v === id);
  return entry?.[0] ?? `FORMAT_${id}`;
}

/** Run the ZXing MultiFormatReader over raw grayscale pixels. */
function decodeWithZxing(luminances: Uint8ClampedArray, width: number, height: number): DecodedCode[] {
  const reader = new MultiFormatReader();
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(
    DecodeHintType.POSSIBLE_FORMATS,
    Object.values(ZXING_FORMAT_IDS).filter(v => typeof v === 'number')
  );
  hints.set(DecodeHintType.TRY_HARDER, true);
  reader.setHints(hints);

  try {
    const source = new RGBLuminanceSource(luminances, width, height);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    const result = reader.decode(bitmap);
    return [
      {
        payload: result.getText(),
        format: zxingFormatName(result.getBarcodeFormat()),
        source: 'zxing',
      },
    ];
  } catch {
    return [];
  } finally {
    reader.reset();
  }
}

function canvasLuminances(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return new Uint8ClampedArray(0);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const out = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) | 0;
  }
  return out;
}

/**
 * Candidate sub-regions (center band, wide middle, center square) so
 * partially visible or small codes get a tighter, higher-contrast crop.
 */
function codeCandidateRegions(canvas: HTMLCanvasElement): BBox[] {
  const w = canvas.width;
  const h = canvas.height;
  const regions: BBox[] = [];
  const quarter = { x0: 0, y0: h * 0.25, x1: w, y1: h * 0.75 };
  const half = { x0: 0, y0: h * 0.15, x1: w, y1: h * 0.85 };
  const centerSquare = {
    x0: w * 0.15,
    y0: h * 0.15,
    x1: w * 0.85,
    y1: h * 0.85,
  };
  regions.push(quarter, half, centerSquare);
  return regions.filter(r => r.x1 - r.x0 > 40 && r.y1 - r.y0 > 40);
}

function dedupeCodes(codes: DecodedCode[]): DecodedCode[] {
  const seen = new Map<string, DecodedCode>();
  for (const code of codes) {
    const key = `${code.format}:${code.payload}`;
    const existing = seen.get(key);
    if (!existing || (code.bbox && !existing.bbox)) {
      seen.set(key, code);
    }
  }
  return [...seen.values()];
}

/**
 * Decode QR / DataMatrix / 1D barcodes on an image canvas.
 * Tries the native detector on the full image, then a ZXing grid over
 * the raw image (crisp modules), a preprocessed grayscale variant and
 * code-area candidate crops, each at 0°/90°/270°.
 */
export async function decodeCodes(sourceCanvas: HTMLCanvasElement): Promise<DecodedCode[]> {
  const codes: DecodedCode[] = [];

  // 1) Native detector on the full-resolution image.
  codes.push(...(await detectNative(sourceCanvas)));

  // 2) ZXing on the raw image first — modules are crisp at native resolution.
  //    The quiet-zone-padded variant lets edge-flush DataMatrix codes detect.
  const rawCanvases = [
    padQuietZone(sourceCanvas),
    ...codeCandidateRegions(sourceCanvas).map(r => padQuietZone(cropCanvas(sourceCanvas, r))),
  ];
  for (const canvas of rawCanvases) {
    for (const turns of [0, 1, 3]) {
      const oriented = rotateQuarter(canvas, turns);
      const lumi = canvasLuminances(oriented);
      if (lumi.length === 0) continue;
      codes.push(...decodeWithZxing(lumi, oriented.width, oriented.height));
    }
  }

  // 3) ZXing grid on the preprocessed grayscale for small/low-contrast codes.
  const gray = grayscaleNormalized(upscaleForOcr(sourceCanvas, 1600));
  const grayCanvases = [padQuietZone(gray), ...codeCandidateRegions(gray).map(r => padQuietZone(cropCanvas(gray, r)))];
  for (const canvas of grayCanvases) {
    for (const turns of [0, 1, 3]) {
      const oriented = rotateQuarter(canvas, turns);
      const lumi = canvasLuminances(oriented);
      if (lumi.length === 0) continue;
      codes.push(...decodeWithZxing(lumi, oriented.width, oriented.height));
    }
  }

  return dedupeCodes(codes);
}

function cropCanvas(source: HTMLCanvasElement, bbox: BBox): HTMLCanvasElement {
  const x = Math.max(0, Math.round(bbox.x0));
  const y = Math.max(0, Math.round(bbox.y0));
  const w = Math.min(source.width - x, Math.max(1, Math.round(bbox.x1 - bbox.x0)));
  const h = Math.min(source.height - y, Math.max(1, Math.round(bbox.y1 - bbox.y0)));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d')?.drawImage(source, x, y, w, h, 0, 0, w, h);
  return out;
}

/**
 * Add a white quiet-zone border (as a fraction of the larger edge).
 * DataMatrix in particular fails to detect when the code touches the
 * image border — e.g. inside tight candidate crops.
 */
function padQuietZone(source: HTMLCanvasElement, fraction = 0.08): HTMLCanvasElement {
  const margin = Math.max(8, Math.round(Math.max(source.width, source.height) * fraction));
  const out = document.createElement('canvas');
  out.width = source.width + margin * 2;
  out.height = source.height + margin * 2;
  const ctx = out.getContext('2d');
  if (!ctx) return out;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, margin, margin);
  return out;
}

/** True when the payload is plausibly a URL (we never auto-open these). */
export function looksLikeUrl(payload: string): boolean {
  return /^https?:\/\//i.test(payload.trim());
}

/**
 * Fast single-frame decode for the live camera 'Scan code' mode:
 * native detector first, else one ZXing pass on a downscaled frame.
 */
export async function decodeLiveFrame(video: HTMLVideoElement): Promise<DecodedCode[]> {
  const native = await detectNative(video);
  if (native.length > 0) return native;

  const scale = Math.min(1, 640 / Math.max(1, video.videoWidth));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
  const lumi = canvasLuminances(canvas);
  if (lumi.length === 0) return [];
  return decodeWithZxing(lumi, canvas.width, canvas.height);
}

export interface ParsedCodePayload {
  kind: 'gs1' | 'url' | 'plain';
  gtin?: string;
  batch?: string;
  expiry?: string;
  serial?: string;
  url?: string;
  domain?: string;
  elements: Array<{ ai: string; label: string; value: string }>;
}

const GS1_AIS: Record<string, string> = {
  '01': 'GTIN',
  '10': 'Batch / Lot',
  '17': 'Expiry',
  '21': 'Serial',
  '11': 'Production date',
};

/** Format an expiry (YYMMDD from AI 17) to MM/YYYY. */
function formatGExpiration(raw: string): string {
  if (raw.length >= 6) {
    const yy = raw.slice(0, 2);
    const mm = raw.slice(2, 4);
    return `${mm}/20${yy}`;
  }
  return raw;
}

/**
 * Parse a decoded payload: GS1 element strings (with FNC1 as \u001d or
 * bracketed AIs), URLs, or plain text. Pure parsing — no fetching, no opening.
 */
export function parseCodePayload(payload: string): ParsedCodePayload {
  const trimmed = payload.trim();

  if (looksLikeUrl(trimmed)) {
    let domain = '';
    try {
      domain = new URL(trimmed).hostname;
    } catch {
      domain = '';
    }
    return { kind: 'url', url: trimmed, domain, elements: [] };
  }

  // GS1: either real FNC1 (\u001d) separators or bracketed AIs like (01)...
  const elements: ParsedCodePayload['elements'] = [];
  const bracketed = /\((\d{2,4})\)([^()]+)/g;
  let match: RegExpExecArray | null;
  let hadBrackets = false;
  while ((match = bracketed.exec(trimmed)) !== null) {
    hadBrackets = true;
    const ai = match[1];
    const label = GS1_AIS[ai] ?? `AI ${ai}`;
    elements.push({ ai, label, value: match[2].trim() });
  }

  if (!hadBrackets && trimmed.includes('\u001d')) {
    // FNC1-separated element string: prefer known 2-digit AIs, else greedy 2-4.
    for (const part of trimmed.split('\u001d')) {
      const two = part.match(/^(\d{2})\s*(.*)$/);
      const four = part.match(/^(\d{4})\s*(.*)$/);
      let ai = '';
      let value = '';
      if (two && GS1_AIS[two[1]]) {
        ai = two[1];
        value = two[2].trim();
      } else if (four && GS1_AIS[four[1]]) {
        ai = four[1];
        value = four[2].trim();
      } else if (two) {
        ai = two[1];
        value = two[2].trim();
      }
      if (ai && value) elements.push({ ai, label: GS1_AIS[ai] ?? `AI ${ai}`, value });
    }
  }

  if (elements.length > 0) {
    const find = (ai: string) => elements.find(e => e.ai === ai)?.value;
    const expiryRaw = find('17');
    return {
      kind: 'gs1',
      gtin: find('01'),
      batch: find('10'),
      // AI 17 is raw YYMMDD in both bracketed and FNC1 forms; format once here.
      expiry: expiryRaw ? formatGExpiration(expiryRaw) : undefined,
      serial: find('21'),
      elements,
    };
  }

  return { kind: 'plain', elements: [] };
}
