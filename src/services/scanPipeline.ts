import { createWorker, type PSM } from 'tesseract.js';
import type { BBox, CaptureSource, DecodedCode, ExtractedData, ExtractionField, FieldKey, ScanResult, SessionPhoto, TextLine } from '../types';
import {
  adaptiveThreshold,
  canvasToJpeg,
  codeNeighborhoodCrop,
  cropRegion,
  decodeImage,
  edgeStripCrops,
  estimateBlur,
  grayscaleNormalized,
  makeThumbnail,
  rotateQuarter,
  splitIntoBands,
  tallNarrowCrops,
  upscaleForOcr,
} from '../utils/image';
import { extractFields, groundExtractedData, mergeExtractedData } from './extract';
import { decodeCodes } from './barcode';
import { computeOverall, computeScanQuality, runChecks } from '../utils/checks';
import { generateId } from '../utils/helpers';

export interface ScanProgress {
  phase: 'preparing' | 'variants' | 'bands' | 'merging' | 'extracting' | 'done';
  /** Human-readable current activity, shown in the live feed. */
  message: string;
  /** 0-100 scan-line position (real progress, not a timer). */
  scanLinePct: number;
  /** Completed OCR run labels, e.g. "gray·0°·psm6". */
  completedRuns: string[];
  totalRuns: number;
  /** New lines found by the most recent run (for the feed). */
  lastRunLines: string[];
}

export class ScanError extends Error {}

const HIGH_CONF = 85;
const MEDIUM_CONF = 60;
const MIN_WORD_CONF = 60;
const MIN_ALNUM_RATIO = 0.4;
const ROTATIONS = [0, 1, 3] as const; // quarter-turns: 0°, 90°, 270°
const PSMS: Array<{ mode: number; label: string }> = [
  { mode: 6, label: 'psm6' },
  { mode: 11, label: 'psm11' },
];

function confidenceFromTesseract(value: number): TextLine['confidence'] {
  if (value >= HIGH_CONF) return 'high';
  if (value >= MEDIUM_CONF) return 'medium';
  return 'low';
}

interface RawLine {
  text: string;
  bbox: BBox;
  confidence: number;
}

/** Extract text lines with geometry from a tesseract.js v7+ recognize result. */
export function linesFromTesseract(data: unknown): RawLine[] {
  const page = data as {
    lines?: unknown[] | null;
    blocks?: Array<{ paragraphs?: Array<{ lines?: Array<{ text?: string; confidence?: number; bbox?: Record<string, number> }> }> }> | null;
    text?: string;
  };

  const out: RawLine[] = [];

  if (Array.isArray(page.blocks)) {
    for (const block of page.blocks) {
      for (const paragraph of block?.paragraphs ?? []) {
        for (const line of paragraph?.lines ?? []) {
          if (!line?.text?.trim()) continue;
          const b = line.bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
          out.push({
            text: line.text,
            confidence: line.confidence ?? 0,
            bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 },
          });
        }
      }
    }
    if (out.length > 0) return out;
  }

  for (const lineText of (page.text ?? '').split('\n')) {
    if (!lineText.trim()) continue;
    out.push({ text: lineText, confidence: MEDIUM_CONF, bbox: { x0: 0, y0: 0, x1: 0, y1: 0 } });
  }
  return out;
}

/** Drop junk: low word-confidence or mostly-symbol lines. */
function passesQualityFilter(line: RawLine, minConf = MIN_WORD_CONF, minAlnum = MIN_ALNUM_RATIO): boolean {
  if (line.confidence < minConf) return false;
  const chars = line.text.replace(/\s/g, '');
  if (chars.length === 0) return false;
  const alnum = chars.replace(/[^a-zA-Z0-9.,:/+\-₹]/g, '').length;
  return alnum / chars.length >= minAlnum;
}

/** Map a bbox from a rotated canvas back to original coordinates. */
function mapRotatedBoxToOriginal(bbox: BBox, rotationTurns: number, canvasW: number, canvasH: number): BBox {
  // rotation 1 (90° cw): (x,y) -> (H - y, x). rotation 3 (270° cw): (x,y) -> (y, W - x)
  if (rotationTurns === 1) {
    return { x0: canvasH - bbox.y1, y0: bbox.x0, x1: canvasH - bbox.y0, y1: bbox.x1 };
  }
  if (rotationTurns === 3) {
    return { x0: bbox.y0, y0: canvasW - bbox.x1, x1: bbox.y1, y1: canvasW - bbox.x0 };
  }
  return bbox;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

function normalizeForCompare(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function iou(a: BBox, b: BBox): number {
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

const CONF_RANK = { high: 3, medium: 2, low: 1 } as const;

/** Dedupe overlapping reads across runs; keep the best text per region. */
export function mergeLines(passes: TextLine[][]): TextLine[] {
  const merged: TextLine[] = [];
  for (const pass of passes) {
    for (const line of pass) {
      const existing = merged.find(m => isDuplicate(m, line));
      if (!existing) {
        merged.push({ ...line });
        continue;
      }
      if (CONF_RANK[line.confidence] > CONF_RANK[existing.confidence]) {
        existing.text = line.text;
        existing.confidence = line.confidence;
        existing.wordConfidence = Math.max(existing.wordConfidence ?? 0, line.wordConfidence ?? 0);
      }
    }
  }
  return merged;
}

function isDuplicate(a: TextLine, b: TextLine): boolean {
  if ((a.orientation ?? 0) !== (b.orientation ?? 0)) return false;
  const na = normalizeForCompare(a.text);
  const nb = normalizeForCompare(b.text);
  if (!na || !nb) return false;
  const sameText = na === nb || (na.length >= 6 && nb.length >= 6 && (na.includes(nb) || nb.includes(na)));
  return sameText && iou(a.bbox, b.bbox) > 0.2;
}

function mapFromUpscaledRotated(
  bbox: BBox,
  turns: number,
  rotatedW: number,
  rotatedH: number,
  scale: number,
  cropOrigin: BBox
): BBox {
  const local: BBox = {
    x0: bbox.x0 / scale,
    y0: bbox.y0 / scale,
    x1: bbox.x1 / scale,
    y1: bbox.y1 / scale,
  };
  const inCrop = mapRotatedBoxToOriginal(local, turns, rotatedW, rotatedH);
  return {
    x0: inCrop.x0 + cropOrigin.x0,
    y0: inCrop.y0 + cropOrigin.y0,
    x1: inCrop.x1 + cropOrigin.x0,
    y1: inCrop.y1 + cropOrigin.y0,
  };
}

const STRIP_MIN_EDGE = 1600;

async function recognizeDedicatedStrips(
  worker: Awaited<ReturnType<typeof createWorker>>,
  source: HTMLCanvasElement,
  codes: DecodedCode[],
  existingBoxes: BBox[],
  onProgress: (p: ScanProgress) => void
): Promise<TextLine[]> {
  const crops = [
    ...edgeStripCrops(source, 0.2),
    ...tallNarrowCrops(source, existingBoxes),
    ...codes.filter(c => c.bbox).map(c => codeNeighborhoodCrop(source, c.bbox as BBox, 90)),
  ];
  const lines: TextLine[] = [];
  let run = 0;
  for (const crop of crops) {
    if (crop.canvas.width < 8 || crop.canvas.height < 8) continue;
    for (const turns of [1, 3] as const) {
      const rotated = rotateQuarter(crop.canvas, turns);
      const upscaled = upscaleForOcr(rotated, STRIP_MIN_EDGE);
      const gray = grayscaleNormalized(upscaled);
      const scale = upscaled.width / Math.max(1, rotated.width);
      await worker.setParameters({ tessedit_pageseg_mode: 6 as unknown as PSM });
      const blockResult = await worker.recognize(gray, {}, { blocks: true });
      const blockLines = linesFromTesseract(blockResult.data).filter(l =>
        passesQualityFilter(l, 30, 0.25)
      );
      run += 1;
      onProgress({
        phase: 'variants',
        message: `Sideways strip ${crop.label} ${turns * 90}°: ${blockLines.length} lines`,
        scanLinePct: 90,
        completedRuns: [`strip·${crop.label}·${turns * 90}`],
        totalRuns: crops.length * 2,
        lastRunLines: blockLines.slice(0, 4).map(l => l.text.trim()),
      });
      for (const line of blockLines) {
        const mapped = mapFromUpscaledRotated(line.bbox, turns, rotated.width, rotated.height, scale, crop.bbox);
        lines.push({
          text: line.text,
          bbox: mapped,
          band: 0,
          confidence: confidenceFromTesseract(line.confidence),
          wordConfidence: line.confidence,
          runLabel: `strip·${crop.label}·psm6·${turns * 90}`,
          orientation: turns === 1 ? 1 : 2,
        });
        const lineCrop = cropRegion(gray, line.bbox);
        if (lineCrop.width < 4 || lineCrop.height < 4) continue;
        await worker.setParameters({ tessedit_pageseg_mode: 7 as unknown as PSM });
        const lineResult = await worker.recognize(lineCrop, {}, { blocks: true });
        for (const one of linesFromTesseract(lineResult.data).filter(l => passesQualityFilter(l, 25, 0.2))) {
          const oneBox: BBox = {
            x0: line.bbox.x0 + one.bbox.x0,
            y0: line.bbox.y0 + one.bbox.y0,
            x1: line.bbox.x0 + Math.max(one.bbox.x1, 1),
            y1: line.bbox.y0 + Math.max(one.bbox.y1, 1),
          };
          lines.push({
            text: one.text,
            bbox: mapFromUpscaledRotated(oneBox, turns, rotated.width, rotated.height, scale, crop.bbox),
            band: 0,
            confidence: confidenceFromTesseract(one.confidence),
            wordConfidence: one.confidence,
            runLabel: `strip·${crop.label}·psm7·${turns * 90}`,
            orientation: turns === 1 ? 1 : 2,
          });
        }
      }
    }
  }
  console.log('sideways-strip OCR lines', lines.length, 'from', run, 'runs');
  return lines;
}

// ---------------------------------------------------------------------------
// Vision-model backend (/api/scan)
// ---------------------------------------------------------------------------

interface VisionResponse {
  usable: boolean;
  reject_reason?: string;
  fields?: Partial<Record<FieldKey, { value: string; confidence: 'high' | 'medium' | 'low' } | null>>;
  text_lines?: Array<{ text: string; bbox: BBox; confidence: number }>;
  unreadable_regions?: Array<{ bbox: BBox; reason: string }>;
}

/**
 * Ask the backend to analyze with a vision model.
 * Returns null only on 501 (no server API key) → caller falls back to Tesseract.
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
    console.log('analyzer unavailable (no server API key) — using on-device OCR');
    return null;
  }
  if (!response.ok) {
    throw new ScanError('Could not analyze image. The analysis service returned an error.');
  }

  const payload = (await response.json()) as VisionResponse;
  console.log('raw analyzer response', payload);
  return payload;
}

// ---------------------------------------------------------------------------
// On-device OCR grid
// ---------------------------------------------------------------------------

interface OcrRun {
  label: string;
  lines: RawLine[];
  /** Mean word confidence of the run. */
  meanConfidence: number;
  /** Distinct medicine keywords found (for run scoring). */
  keywordHits: number;
  orientation: 0 | 1 | 2;
}

async function recognizeAll(
  worker: Awaited<ReturnType<typeof createWorker>>,
  variants: Array<{ label: string; canvas: HTMLCanvasElement }>,
  onProgress: (p: ScanProgress) => void,
  totalRuns: number,
  completed: string[]
): Promise<OcrRun[]> {
  const runs: OcrRun[] = [];
  for (const variant of variants) {
    for (const turns of ROTATIONS) {
      const oriented = rotateQuarter(variant.canvas, turns);
      for (const psm of PSMS) {
        const label = `${variant.label}·${turns * 90}°·${psm.label}`;
        await worker.setParameters({ tessedit_pageseg_mode: psm.mode as unknown as PSM });
        const result = await worker.recognize(oriented, {}, { blocks: true });
        const lines = linesFromTesseract(result.data).filter(passesQualityFilter);
        const meanConfidence =
          lines.length > 0 ? lines.reduce((s, l) => s + l.confidence, 0) / lines.length : 0;
        runs.push({
          label,
          lines,
          meanConfidence,
          keywordHits: countKeywords(lines.map(l => l.text).join('\n')),
          orientation: (turns === 0 ? 0 : turns === 1 ? 1 : 2) as 0 | 1 | 2,
        });
        completed.push(label);
        onProgress({
          phase: 'variants',
          message: `Read ${label}: ${lines.length} lines`,
          scanLinePct: (completed.length / totalRuns) * 100,
          completedRuns: [...completed],
          totalRuns,
          lastRunLines: lines.slice(0, 4).map(l => l.text.trim()),
        });
        console.log(`raw analyzer response (${label})`, lines.length, 'lines, mean conf', Math.round(meanConfidence));
      }
    }
  }
  return runs;
}

function countKeywords(text: string): number {
  const patterns = [
    /\btablets?\b/i, /\bcapsules?\b/i, /\bmg\b|\bmcg\b/i, /\bI\.?P\.?\b|\bUSP\b/i,
    /\bRx\b/i, /\bschedule\b/i, /\bmanufactured\b|\bmfd\b|\bmfg\b/i, /\bmarketed\b/i,
    /\bbatch\b|\bb\.?\s*no\b|\blot\b/i, /\bexp\b|\bexpiry\b/i, /\bm\.?r\.?p\b/i, /\bcomposition\b/i,
  ];
  return patterns.reduce((count, re) => (re.test(text) ? count + 1 : count), 0);
}

/** Convert runs to positioned TextLines (bbox mapped back to original space). */
function runsToTextLines(
  runs: OcrRun[],
  variantSizes: Record<string, { w: number; h: number }>,
  baseSize: { w: number; h: number }
): TextLine[][] {
  return runs.map(run => {
    const [variantLabel, rotationLabel] = run.label.split('·');
    const turns = parseInt(rotationLabel, 10) / 90;
    const size = variantSizes[variantLabel] ?? baseSize;
    return run.lines.map(line => ({
      text: line.text,
      bbox: mapRotatedBoxToOriginal(line.bbox, turns, size.w, size.h),
      band: 0,
      confidence: confidenceFromTesseract(line.confidence),
      wordConfidence: line.confidence,
      runLabel: run.label,
      orientation: run.orientation,
    }));
  });
}

// ---------------------------------------------------------------------------
// Pipeline entry
// ---------------------------------------------------------------------------

export interface ScanInput {
  file: Blob;
  source: CaptureSource;
  /** Present when re-scanning a crop of a previous photo. */
  crop?: BBox;
  photoLabel: string;
}

export async function runScan(
  input: ScanInput,
  onProgress: (progress: ScanProgress) => void
): Promise<{
  result: Omit<ScanResult, 'photos' | 'skippedFields' | 'userEnteredFields' | 'identification' | 'drugClass' | 'batchInfo'>;
  raw: unknown;
}> {
  console.log('image received', input.photoLabel, input.file.size, input.file.type);

  onProgress(progressFor('preparing', 'Preparing image…', 0, [], 0, []));
  const decoded = await decodeImage(input.file);
  const sourceCanvas = input.crop ? cropRegion(decoded.canvas, input.crop) : decoded.canvas;
  const thumbnail = makeThumbnail(sourceCanvas);
  const blurScore = estimateBlur(sourceCanvas);
  console.log('image decoded', sourceCanvas.width, 'x', sourceCanvas.height, 'blur', blurScore.toFixed(4));

  // QR / DataMatrix / 1D codes decode on the original color image so both
  // analyzer paths (vision model + on-device OCR) get them.
  let codes: DecodedCode[] = [];
  try {
    codes = await decodeCodes(sourceCanvas);
    if (codes.length > 0) {
      console.log('codes decoded:', codes.map(c => `${c.format} "${c.payload.slice(0, 40)}"`).join(' | '));
    }
  } catch (err) {
    console.error('code decoding failed (non-fatal)', err);
  }

  const width = sourceCanvas.width;
  const height = sourceCanvas.height;

  // Try the vision-model backend first.
  try {
    const vision = await analyzeWithVisionModel(canvasToJpeg(sourceCanvas));
    if (vision) {
      onProgress(progressFor('extracting', 'Grounding vision text…', 70, [], 100, []));
      let data = dataFromVision(vision, blurScore, codes);
      const worker = await createWorker('eng');
      try {
        const stripLines = await recognizeDedicatedStrips(worker, sourceCanvas, codes, data.rawTextLines.map(l => l.bbox), onProgress);
        if (stripLines.length > 0) {
          data = mergeExtractedData(data, extractFields(stripLines, blurScore, codes));
        }
      } finally {
        await worker.terminate();
      }
      data = groundExtractedData(data);
      logSessionParse(data);
      onProgress(progressFor('extracting', 'Building result…', 100, [], 100, []));
      return {
        result: buildResult(data, thumbnail, input.source, 'vision-model', width, height),
        raw: { vision, mergedText: data.rawTextLines.map(l => l.text) },
      };
    }
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError('Could not analyze image.');
  }

  // On-device OCR grid: 2 variants × 3 rotations × 2 PSMs = 12 runs.
  const worker = await createWorker('eng');
  try {
    const upscaled = upscaleForOcr(sourceCanvas);
    const gray = grayscaleNormalized(upscaled);
    const thresholded = adaptiveThreshold(gray);

    const variants = [
      { label: 'gray', canvas: gray },
      { label: 'thresh', canvas: thresholded },
    ];
    const variantSizes: Record<string, { w: number; h: number }> = {};
    for (const variant of variants) {
      variantSizes[variant.label] = { w: variant.canvas.width, h: variant.canvas.height };
    }

    const totalRuns = variants.length * ROTATIONS.length * PSMS.length;
    const completed: string[] = [];

    // Bands over the grayscale variant drive the top-to-bottom scan line.
    const bands = splitIntoBands(gray, 5);

    const runs = await recognizeAll(worker, variants, onProgress, totalRuns, completed);

    // Band passes on the best upright variant for the scan-line narrative.
    const bandLines: TextLine[][] = [];
    for (const band of bands) {
      const bandResult = await worker.recognize(band.canvas, {}, { blocks: true });
      const bandRun = linesFromTesseract(bandResult.data)
        .filter(passesQualityFilter)
        .map(line => ({
          text: line.text,
          bbox: { ...line.bbox, y0: line.bbox.y0 + band.y0, y1: line.bbox.y1 + band.y0 } as BBox,
          confidence: line.confidence,
        }));
      bandLines.push(
        bandRun.map(line => ({
          text: line.text,
          bbox: line.bbox,
          band: band.index,
          confidence: confidenceFromTesseract(line.confidence),
          wordConfidence: line.confidence,
          runLabel: `band${band.index}`,
          orientation: 0 as const,
        }))
      );
      const pct = (band.y1 / gray.height) * 90;
      onProgress(
        progressFor(
          'bands',
          `Band ${band.index}/${bands.length}: ${bandRun.length} lines`,
          pct,
          completed,
          totalRuns,
          bandRun.slice(0, 4).map(l => l.text.trim())
        )
      );
    }

    onProgress(progressFor('merging', 'Merging reads…', 95, completed, totalRuns, []));
    const allPasses = runsToTextLines(runs, variantSizes, { w: width, h: height });
    const stripLines = await recognizeDedicatedStrips(
      worker,
      sourceCanvas,
      codes,
      [...allPasses, ...bandLines].flat().map(l => l.bbox),
      onProgress
    );
    const merged = mergeLines([...allPasses, ...bandLines, stripLines]);
    console.log('merged raw text', merged.map(l => l.text).join(' | '));
    console.log('merged lines', merged.length, 'from', allPasses.length + bandLines.length + 1, 'passes');

    // Collect ALL lines without the quality filter — used only for dataset keyword matching.
    const allOcrLines: TextLine[] = runs.flatMap((run, i) => {
      const [variantLabel, rotationLabel] = run.label.split('·');
      const turns = parseInt(rotationLabel, 10) / 90;
      const size = variantSizes[variantLabel] ?? { w: width, h: height };
      return run.lines.map(line => ({
        text: line.text,
        bbox: mapRotatedBoxToOriginal(line.bbox, turns, size.w, size.h),
        band: 0,
        confidence: confidenceFromTesseract(line.confidence),
        wordConfidence: line.confidence,
        runLabel: run.label,
        orientation: (turns === 0 ? 0 : turns === 1 ? 1 : 2) as 0 | 1 | 2,
      }));
    });
    console.log('[allOcrLines] total unfiltered lines:', allOcrLines.length);

    onProgress(progressFor('extracting', 'Extracting fields…', 99, completed, totalRuns, []));
    const data = extractFields(merged, blurScore, codes);
    // Override allOcrLines with the full unfiltered set so dataset matching has everything.
    data.allOcrLines = allOcrLines;
    logSessionParse(data);

    if (!data.fields.qr_or_barcode_present) {
      const barcode = merged.find(line => /\d{8,}/.test(line.text));
      if (barcode) {
        data.fields.qr_or_barcode_present = {
          value: 'Barcode digits detected',
          confidence: 'medium',
          origin: 'image',
          provenance: { bbox: barcode.bbox, matchedText: barcode.text.trim(), runLabel: barcode.runLabel },
        };
      }
    }

    return {
      result: buildResult(data, thumbnail, input.source, 'tesseract', width, height),
      raw: merged,
    };
  } finally {
    await worker.terminate();
  }
}

function buildResult(
  data: ExtractedData,
  thumbnail: string,
  source: CaptureSource,
  analyzer: ScanResult['analyzer'],
  imageWidth: number,
  imageHeight: number
): Omit<ScanResult, 'photos' | 'skippedFields' | 'userEnteredFields' | 'identification' | 'drugClass' | 'batchInfo'> {
  const checks = runChecks(data);
  return {
    id: generateId(),
    timestamp: new Date().toISOString(),
    imageUrl: thumbnail,
    captureSource: source,
    analyzer,
    riskLevel: computeOverall(checks),
    extractedData: data,
    checks,
    scanQuality: computeScanQuality(data),
    imageWidth,
    imageHeight,
  };
}

function logSessionParse(data: ExtractedData): void {
  console.log('merged raw text', data.rawTextLines.map(l => l.text).join('\n'));
  console.log(
    'parsed fields',
    Object.fromEntries((Object.keys(data.fields) as FieldKey[]).map(k => [k, data.fields[k]?.value ?? null]))
  );
  console.log(
    'candidates',
    data.candidates.map(c => ({ key: c.key, value: c.value, reason: c.reason, matchedText: c.matchedText }))
  );
}

function dataFromVision(vision: VisionResponse, blurScore: number, codes: DecodedCode[]): ExtractedData {
  const textLines: TextLine[] = (vision.text_lines ?? []).map(line => ({
    text: line.text,
    bbox: line.bbox ?? { x0: 0, y0: 0, x1: 0, y1: 0 },
    band: 0,
    confidence: line.confidence >= HIGH_CONF ? 'high' : line.confidence >= MEDIUM_CONF ? 'medium' : 'low',
    wordConfidence: line.confidence,
    orientation: 0,
  }));
  const parsed = extractFields(textLines, blurScore, codes);
  const fields = emptyFields();
  if (vision.fields) {
    for (const key of Object.keys(fields) as FieldKey[]) {
      const value = vision.fields[key];
      if (value && typeof value.value === 'string' && value.value.trim() !== '') {
        const line =
          textLines.find(l => fuzzyLineHas(l.text, value.value)) ??
          textLines.find(l => l.bbox && vision.fields?.[key]);
        fields[key] = {
          value: value.value.trim(),
          confidence: value.confidence ?? 'low',
          origin: 'image',
          matchQuality: value.confidence === 'high' ? 'strict' : 'fuzzy',
          provenance: line
            ? { bbox: line.bbox, matchedText: line.text.trim(), runLabel: 'vision' }
            : undefined,
        };
      }
    }
  }
  const merged = mergeExtractedData(parsed, {
    ...parsed,
    fields,
    candidates: [],
  });
  const grounded = groundExtractedData(merged);
  // For vision model: all text_lines are "unfiltered" (the model already handles confidence).
  grounded.allOcrLines = textLines;
  return grounded;
}

function fuzzyLineHas(line: string, value: string): boolean {
  const hay = line.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  const ned = value.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  return ned.length >= 3 && hay.includes(ned);
}

function emptyFields(): Record<FieldKey, ExtractionField | null> {
  return {
    brand_name: null,
    composition: null,
    dosage_form: null,
    manufacturer_name: null,
    marketer_name: null,
    manufacturing_license_no: null,
    batch_no: null,
    mfg_date: null,
    expiry_date: null,
    mrp: null,
    schedule_marking: null,
    qr_or_barcode_present: null,
    pill_imprint: null,
  };
}

function progressFor(
  phase: ScanProgress['phase'],
  message: string,
  scanLinePct: number,
  completedRuns: string[],
  totalRuns: number,
  lastRunLines: string[]
): ScanProgress {
  return { phase, message, scanLinePct, completedRuns, totalRuns, lastRunLines };
}

export type { SessionPhoto };
