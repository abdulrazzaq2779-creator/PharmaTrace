/**
 * Real image processing for OCR: decoding, upscaling, preprocessing variants,
 * rotations, crops, thumbnails and blur estimation. All pixel work, no simulation.
 */

export interface DecodedImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/** Longest edge for storage/display. */
export const MAX_EDGE = 1600;
/** Longest edge targeted for OCR — small text needs the extra pixels. */
export const OCR_MIN_EDGE = 2000;

/** Decode a File/Blob into a canvas capped at maxEdge on the longest side. */
export async function decodeImage(file: Blob, maxEdge = MAX_EDGE): Promise<DecodedImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas is not supported in this browser.');
    ctx.drawImage(bitmap, 0, 0, width, height);
    return { canvas, width, height };
  } finally {
    bitmap.close();
  }
}

export function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.9): string {
  return canvas.toDataURL('image/jpeg', quality);
}

export function makeThumbnail(canvas: HTMLCanvasElement, maxEdge = 320): string {
  const scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  const thumb = document.createElement('canvas');
  thumb.width = Math.max(1, Math.round(canvas.width * scale));
  thumb.height = Math.max(1, Math.round(canvas.height * scale));
  thumb.getContext('2d')?.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL('image/jpeg', 0.7);
}

/** Upscale so the longest edge is at least minEdge (OCR needs pixels for small print). */
export function upscaleForOcr(source: HTMLCanvasElement, minEdge = OCR_MIN_EDGE): HTMLCanvasElement {
  const longest = Math.max(source.width, source.height);
  const scale = Math.max(1, minEdge / longest);
  if (scale === 1) return source;
  const out = document.createElement('canvas');
  out.width = Math.round(source.width * scale);
  out.height = Math.round(source.height * scale);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, out.width, out.height);
  }
  return out;
}

/** Grayscale + per-channel contrast stretch (1st-99th percentile). */
export function grayscaleNormalized(source: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  if (!ctx) return out;
  ctx.drawImage(source, 0, 0);

  const img = ctx.getImageData(0, 0, out.width, out.height);
  const data = img.data;
  const n = data.length / 4;
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const gray = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) | 0;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = gray;
    hist[gray]++;
  }
  // Contrast stretch between the 1st and 99th percentiles.
  let lo = 0;
  let hi = 255;
  let acc = 0;
  const loCut = n * 0.01;
  const hiCut = n * 0.99;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc < loCut) lo = v;
    if (acc < hiCut) hi = v;
  }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < n; i++) {
    const stretched = Math.max(0, Math.min(255, ((data[i * 4] - lo) * 255) / range));
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = stretched;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/**
 * Adaptive threshold via integral image (Bradley/Wellner): a pixel goes black
 * if it is darker than the mean of its (t%) neighborhood. Good for photos
 * with shadows or uneven lighting.
 */
export function adaptiveThreshold(source: HTMLCanvasElement, windowRadius = 24, t = 0.15): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const srcCtx = source.getContext('2d', { willReadFrequently: true });
  const dstCtx = out.getContext('2d', { willReadFrequently: true });
  if (!srcCtx || !dstCtx) return out;

  const img = srcCtx.getImageData(0, 0, w, h);
  const data = img.data;
  const gray = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  // Integral image for O(1) window means.
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
    }
  }

  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - windowRadius);
    const y1 = Math.min(h - 1, y + windowRadius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - windowRadius);
      const x1 = Math.min(w - 1, x + windowRadius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * (w + 1) + (x1 + 1)] -
        integral[y0 * (w + 1) + (x1 + 1)] -
        integral[(y1 + 1) * (w + 1) + x0] +
        integral[y0 * (w + 1) + x0];
      const i = y * w + x;
      const v = gray[i] <= sum / area * (1 - t) ? 0 : 255;
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    }
  }
  dstCtx.putImageData(img, 0, 0);
  return out;
}

export function rotate90(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = canvas.height;
  out.height = canvas.width;
  const ctx = out.getContext('2d');
  if (ctx) {
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  }
  return out;
}

export function rotate270(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = canvas.height;
  out.height = canvas.width;
  const ctx = out.getContext('2d');
  if (ctx) {
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  }
  return out;
}

/** Rotate by an arbitrary number of quarter-turns (0-3). */
export function rotateQuarter(canvas: HTMLCanvasElement, turns: number): HTMLCanvasElement {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return canvas;
  if (t === 1) return rotate90(canvas);
  if (t === 2) {
    const once = rotate90(canvas);
    return rotate90(once);
  }
  return rotate270(canvas);
}

export interface Band {
  index: number;
  canvas: HTMLCanvasElement;
  y0: number;
  y1: number;
  overlapPx: number;
}

/** Split into horizontal bands with ~15% overlap for top-to-bottom scanning. */
export function splitIntoBands(image: HTMLCanvasElement, bandCount = 5): Band[] {
  const height = image.height;
  const bandHeight = height / bandCount;
  const overlapPx = Math.round(bandHeight * 0.15);
  const bands: Band[] = [];

  for (let i = 0; i < bandCount; i++) {
    const y0 = Math.max(0, Math.round(i * bandHeight - (i > 0 ? overlapPx : 0)));
    const y1 = Math.min(height, Math.round((i + 1) * bandHeight + (i < bandCount - 1 ? overlapPx : 0)));
    const cropHeight = y1 - y0;
    if (cropHeight < 8) continue;
    const crop = document.createElement('canvas');
    crop.width = image.width;
    crop.height = cropHeight;
    crop.getContext('2d')?.drawImage(image, 0, y0, image.width, cropHeight, 0, 0, image.width, cropHeight);
    bands.push({ index: bands.length + 1, canvas: crop, y0, y1, overlapPx });
  }
  return bands;
}

/** Crop a region (in source pixel coords) out of a canvas. */
export function cropRegion(source: HTMLCanvasElement, bbox: BBox): HTMLCanvasElement {
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

export interface NamedCrop {
  label: string;
  canvas: HTMLCanvasElement;
  bbox: BBox;
}

/** Left and right 20% edges — blister strips print batch/EXP sideways here. */
export function edgeStripCrops(source: HTMLCanvasElement, fraction = 0.2): NamedCrop[] {
  const w = source.width;
  const h = source.height;
  const strip = Math.max(24, Math.round(w * fraction));
  const left: BBox = { x0: 0, y0: 0, x1: strip, y1: h };
  const right: BBox = { x0: Math.max(0, w - strip), y0: 0, x1: w, y1: h };
  return [
    { label: 'left-edge', canvas: cropRegion(source, left), bbox: left },
    { label: 'right-edge', canvas: cropRegion(source, right), bbox: right },
  ];
}

export function expandBBox(bbox: BBox, pad: number, width: number, height: number): BBox {
  return {
    x0: Math.max(0, bbox.x0 - pad),
    y0: Math.max(0, bbox.y0 - pad),
    x1: Math.min(width, bbox.x1 + pad),
    y1: Math.min(height, bbox.y1 + pad),
  };
}

/** Crop around a decoded QR/barcode so nearby batch text is included. */
export function codeNeighborhoodCrop(source: HTMLCanvasElement, bbox: BBox, pad = 80): NamedCrop {
  const expanded = expandBBox(bbox, pad, source.width, source.height);
  return { label: 'code-neighborhood', canvas: cropRegion(source, expanded), bbox: expanded };
}

/** Tall, narrow boxes (sideways print). */
export function tallNarrowCrops(source: HTMLCanvasElement, boxes: BBox[]): NamedCrop[] {
  const out: NamedCrop[] = [];
  boxes.forEach((bbox, i) => {
    const w = Math.max(1, bbox.x1 - bbox.x0);
    const h = Math.max(1, bbox.y1 - bbox.y0);
    if (h >= w * 2.5 && h >= 40) {
      const expanded = expandBBox(bbox, 12, source.width, source.height);
      out.push({ label: `tall-narrow-${i}`, canvas: cropRegion(source, expanded), bbox: expanded });
    }
  });
  return out;
}

import type { BBox } from '../types';

/** Estimate blur via variance of the Laplacian. Lower = blurrier. */
export function estimateBlur(canvas: HTMLCanvasElement): number {
  const small = document.createElement('canvas');
  const w = (small.width = 256);
  const h = (small.height = Math.max(1, Math.round((canvas.height / canvas.width) * 256)));
  const ctx = small.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.drawImage(canvas, 0, 0, w, h);

  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
  }

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  return sumSq / count - (sum / count) ** 2;
}
