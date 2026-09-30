import { createWorker } from 'tesseract.js';
import type { CaptureSource, ExtractedData, ExtractionField, ScanResult, TextLine } from '../types';
import {
  canvasToJpeg,
  decodeImage,
  estimateBlur,
  makeThumbnail,
  rotate90,
  splitIntoBands,
  type Band,
} from '../utils/image';
import { extractFields } from './extract';
import { computeOverall, computeScanQuality, runChecks } from '../utils/checks';
import { generateId } from '../utils/helpers';

export interface ScanProgress {
  phase: 'preparing' | 'bands' | 'rotated' | 'full-pass' | 'merging' | 'extracting' | 'done';
  bandIndex: number;
  totalBands: number;
  /** 0-100 position of the scan line over the image (real progress, not a timer). */
  scanLinePct: number;
  /** 1-based indexes of bands whose results are already merged (for tinting). */
  completedBands: number[];
  message: string;
}

export class ScanError extends Error {}

const TESSERACT_HIGH = 85;
const TESSERACT_MEDIUM = 60;

function confidenceFromTesseract(value: number): TextLine['confidence'] {
  if (value >= TESSERACT_HIGH) return 'high';
  if (value >= TESSERACT_MEDIUM) return 'medium';
  return 'low';
}

/** Extract text lines from any tesseract.js recognize() result shape. */
function linesFromTesseract(data: {
  lines?: unknown[];
  blocks?: unknown[];
  text?: string;
}): Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; confidence: number }> {
  const out: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; confidence: number }> = [];

  if (Array.isArray(data.lines)) {
    for (const line of data.lines as Array<{ text?: string; confidence?: number; bbox?: Record<string, number> }>) {
      if (!line?.text?.trim()) continue;
      const b = line.bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
      out.push({ text: line.text, confidence: line.confidence ?? 0, bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } });
    }
    return out;
  }

  if (Array.isArray(data.blocks)) {
    for (const block of data.blocks as Array<{ paragraphs?: Array<{ lines?: unknown[] }> }>) {
      for (const paragraph of block.paragraphs ?? []) {
        for (const line of (paragraph.lines ?? []) as Array<{ text?: string; confidence?: number; bbox?: Record<string, number> }>) {
          if (!line?.text?.trim()) continue;
          const b = line.bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
          out.push({ text: line.text, confidence: line.confidence ?? 0, bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } });
        }
      }
    }
    if (out.length > 0) return out;
  }

  // Last resort: whole text without geometry.
  for (const text of (data.text ?? '').split('\n')) {
    if (!text.trim()) continue;
    out.push({ text, confidence: TESSERACT_MEDIUM, bbox: { x0: 0, y0: 0, x1: 0, y1: 0 } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merging: dedupe overlapping reads across bands/orientations, keep order.
// ---------------------------------------------------------------------------

function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function iou(a: TextLine['bbox'], b: TextLine['bbox']): number {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
  const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

function isDuplicate(a: TextLine, b: TextLine): boolean {
  if ((a.orientation ?? 0) !== (b.orientation ?? 0)) return false;
  const na = normalizeForCompare(a.text);
  const nb = normalizeForCompare(b.text);
  if (!na || !nb) return false;
  const sameText = na === nb || (na.length >= 6 && nb.length >= 6 && (na.includes(nb) || nb.includes(na)));
  return sameText && iou(a.bbox, b.bbox) > 0.25;
}

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 } as const;

/** Merge band + orientation passes into deduplicated reading order. */
export function mergeLines(passes: TextLine[][]): TextLine[] {
  const merged: TextLine[] = [];
  for (const pass of passes) {
    for (const line of pass) {
      const existing = merged.find(m => isDuplicate(m, line));
      if (!existing) {
        merged.push({ ...line });
        continue;
      }
      // Keep the better read; remember that another pass also saw it.
      if (CONFIDENCE_RANK[line.confidence] > CONFIDENCE_RANK[existing.confidence]) {
        existing.text = line.text;
        existing.confidence = line.confidence;
      }
      existing.fields = [...new Set([...(existing.fields ?? []), ...(line.fields ?? [])])];
    }
  }
  return merged.sort((a, b) => {
    const orientA = a.orientation ?? 0;
    const orientB = b.orientation ?? 0;
    if (orientA !== orientB) return orientA - orientB;
    if (Math.abs(a.bbox.y0 - b.bbox.y0) > 12) return a.bbox.y0 - b.bbox.y0;
    return a.bbox.x0 - b.bbox.x0;
  });
}

/** Map a bbox from the rotate90()-ed image back to original coordinates. */
function mapRotatedBoxToOriginal(
  bbox: { x0: number; y0: number; x1: number; y1: number },
  originalHeight: number
): TextLine['bbox'] {
  return {
    x0: bbox.y0,
    y0: originalHeight - bbox.x1,
    x1: bbox.y1,
    y1: originalHeight - bbox.x0,
  };
}

// ---------------------------------------------------------------------------
// Vision-model backend (/api/scan)
// ---------------------------------------------------------------------------

interface VisionResponse {
  usable: boolean;
  reject_reason?: string;
  fields?: Partial<Record<keyof ExtractedData['fields'], { value: string; confidence: 'high' | 'medium' | 'low' } | null>>;
  text_lines?: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; confidence: number }>;
  unreadable_regions?: Array<{ bbox: TextLine['bbox']; reason: string }>;
}

/**
 * Ask the backend to analyze the image with a vision model.
 * Returns null only when the backend has no API key (501) — the caller then
 * falls back to on-device Tesseract. Any other failure throws.
 */
export async function analyzeWithVisionModel(dataUrl: string): Promise<VisionResponse | null> {
  console.log('sending to analyzer', '/api/scan', `${Math.round(dataUrl.length / 1024)} KB base64`);
  let response: Response;
  try {
    response = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl }),
    });
  } catch {
    throw new ScanError('Could not analyze image. The analysis service is unreachable.');
  }

  if (response.status === 501) {
    console.log('analyzer unavailable (no server API key) — falling back to on-device OCR');
    return null;
  }
  if (!response.ok) {
    throw new ScanError('Could not analyze image. The analysis service returned an error.');
  }

  const payload = (await response.json()) as VisionResponse;
  console.log('raw analyzer response', payload);
  return payload;
}

function fieldsFromVision(vision: VisionResponse): ExtractedData['fields'] {
  const fields = emptyFields();
  if (!vision.fields) return fields;
  for (const key of Object.keys(fields) as Array<keyof ExtractedData['fields']>) {
    const value = vision.fields[key];
    if (value && typeof value.value === 'string' && value.value.trim() !== '') {
      fields[key] = {
        value: value.value.trim(),
        confidence: value.confidence ?? 'low',
        sourceLines: 0,
      };
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Pipeline entry
// ---------------------------------------------------------------------------

export async function runScan(
  file: File,
  source: CaptureSource,
  onProgress: (progress: ScanProgress) => void
): Promise<{ result: ScanResult; raw: unknown }> {
  console.log('image received', file.name || 'camera-capture.jpg', file.size, file.type);

  // 1. Decode + downscale (longest edge ~1600px, text stays legible).
  onProgress(progress('preparing', 0, 0, [], 0, 'Preparing image…'));
  const image = await decodeImage(file);
  const thumbnail = makeThumbnail(image.canvas);
  const blurScore = estimateBlur(image.canvas);
  console.log('image decoded', image.width, 'x', image.height, 'blur score', blurScore.toFixed(4));

  // 2. Try the vision-model backend first.
  const jpeg = canvasToJpeg(image.canvas);
  try {
    const vision = await analyzeWithVisionModel(jpeg);
    if (vision) {
      onProgress(progress('extracting', 0, 0, [], 100, 'Building result…'));
      const data = dataFromVision(vision, blurScore);
      return { result: buildResult(data, image, thumbnail, source, 'vision-model'), raw: vision };
    }
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError('Could not analyze image.');
  }

  // 3. On-device Tesseract fallback: full pass + bands + rotated pass.
  const raw = await runTesseractScan(image.canvas, onProgress);
  onProgress(progress('merging', 0, 0, allBands(raw.totalBands), 100, 'Merging reads…'));
  const merged = mergeLines([raw.fullPassLines, ...raw.bandLines, raw.rotatedLines]);
  console.log('merged lines', merged.length, 'from', raw.bandLines.length, 'bands + rotated pass');

  onProgress(progress('extracting', 0, 0, allBands(raw.totalBands), 100, 'Extracting fields…'));
  const data = extractFields(merged, blurScore);

  // Barcode/QR: a long digit run in the full-image pass is a real barcode signal.
  if (!data.fields.qr_or_barcode_present) {
    const barcode = raw.fullPassLines.find(line => /\d{8,}/.test(line.text));
    if (barcode) {
      data.fields.qr_or_barcode_present = { value: 'Barcode digits detected', confidence: 'medium', sourceLines: 1 };
    }
  }

  return { result: buildResult(data, image, thumbnail, source, 'tesseract'), raw: merged };
}

interface TesseractScanOutput {
  fullPassLines: TextLine[];
  bandLines: TextLine[][];
  rotatedLines: TextLine[];
  totalBands: number;
}

async function runTesseractScan(
  canvas: HTMLCanvasElement,
  onProgress: (progress: ScanProgress) => void
): Promise<TesseractScanOutput> {
  const worker = await createWorker('eng');
  try {
    // Full-image pass: layout, logos, long digit runs (barcodes).
    onProgress(progress('full-pass', 0, 0, [], 2, 'Reading full image…'));
    const full = await worker.recognize(canvas);
    const fullPassLines: TextLine[] = linesFromTesseract(full.data).map(line => ({
      text: line.text,
      bbox: line.bbox,
      band: 0,
      confidence: confidenceFromTesseract(line.confidence),
      orientation: 0,
    }));
    console.log('raw analyzer response (tesseract full pass)', fullPassLines.length, 'lines');

    // Top-to-bottom bands with overlap; scan line follows band bottoms.
    const bands = splitIntoBands(canvas, 5);
    const bandLines: TextLine[][] = [];
    const completedBands: number[] = [];
    for (const band of bands) {
      onProgress(
        progress('bands', band.index, bands.length, [...completedBands], (band.y0 / canvas.height) * 100,
          `Band ${band.index}/${bands.length}: reading…`)
      );
      const result = await worker.recognize(band.canvas);
      const lines = linesFromTesseract(result.data)
        .filter(line => line.text.trim().length > 0)
        .map(line => ({
          text: line.text,
          bbox: {
            x0: line.bbox.x0,
            y0: line.bbox.y0 + band.y0,
            x1: line.bbox.x1,
            y1: line.bbox.y1 + band.y0,
          },
          confidence: confidenceFromTesseract(line.confidence),
        }));
      console.log(`band ${band.index}/${bands.length} found`, lines.map(l => l.text.trim()).filter(Boolean));
      bandLines.push(
        lines.map(line => ({ ...line, band: band.index, orientation: 0 as const }))
      );
      completedBands.push(band.index);
      onProgress(
        progress('bands', band.index, bands.length, [...completedBands], (band.y1 / canvas.height) * 100,
          `Band ${band.index}/${bands.length}: found ${lines.length} line${lines.length === 1 ? '' : 's'}`)
      );
    }

    // Rotated pass: blister strips often print batch/expiry sideways.
    onProgress(progress('rotated', 0, 0, [...completedBands], 50, 'Checking rotated orientation…'));
    const rotated = rotate90(canvas);
    const rotatedResult = await worker.recognize(rotated);
    const rotatedLines: TextLine[] = linesFromTesseract(rotatedResult.data)
      .filter(line => line.text.trim().length > 0)
      .map(line => ({
        text: line.text,
        bbox: mapRotatedBoxToOriginal(line.bbox, canvas.height),
        band: 0,
        confidence: confidenceFromTesseract(line.confidence),
        orientation: 1 as const,
      }));
    console.log('raw analyzer response (tesseract rotated pass)', rotatedLines.length, 'lines');

    return { fullPassLines, bandLines, rotatedLines, totalBands: bands.length };
  } finally {
    await worker.terminate();
  }
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

function buildResult(
  data: ExtractedData,
  image: { canvas: HTMLCanvasElement; width: number; height: number },
  thumbnail: string,
  source: CaptureSource,
  analyzer: ScanResult['analyzer']
): ScanResult {
  const checks = runChecks(data);
  return {
    id: generateId(),
    timestamp: new Date().toISOString(),
    imageUrl: thumbnail || canvasToJpeg(image.canvas, 0.6),
    captureSource: source,
    analyzer,
    riskLevel: computeOverall(checks),
    extractedData: data,
    checks,
    scanQuality: computeScanQuality(data),
    imageWidth: image.width,
    imageHeight: image.height,
  };
}

function dataFromVision(vision: VisionResponse, blurScore: number): ExtractedData {
  const textLines: TextLine[] = (vision.text_lines ?? []).map(line => ({
    text: line.text,
    bbox: line.bbox,
    band: 0,
    confidence: line.confidence >= TESSERACT_HIGH ? 'high' : line.confidence >= TESSERACT_MEDIUM ? 'medium' : 'low',
    orientation: 0,
  }));
  const data: ExtractedData = {
    usable: vision.usable,
    rejectReason: vision.reject_reason,
    fields: fieldsFromVision(vision),
    rawTextLines: textLines,
    unreadableRegions: vision.unreadable_regions ?? [],
    rotatedPassLines: [],
    blurScore,
  };
  return data;
}

function emptyFields(): ExtractedData['fields'] {
  const fields: Record<string, ExtractionField | null> = {};
  for (const key of [
    'brand_name', 'composition', 'dosage_form', 'manufacturer_name', 'marketer_name',
    'manufacturing_license_no', 'batch_no', 'mfg_date', 'expiry_date', 'mrp',
    'schedule_marking', 'qr_or_barcode_present', 'pill_imprint',
  ]) {
    fields[key] = null;
  }
  return fields as ExtractedData['fields'];
}

function progress(
  phase: ScanProgress['phase'],
  bandIndex: number,
  totalBands: number,
  completedBands: number[],
  scanLinePct: number,
  message: string
): ScanProgress {
  return { phase, bandIndex, totalBands, completedBands, scanLinePct, message };
}

function allBands(total: number): number[] {
  return Array.from({ length: total }, (_, i) => i + 1);
}

export type { Band };
