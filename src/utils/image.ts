/**
 * Real image processing: decoding, resizing, band splitting, rotation,
 * thumbnails and blur estimation. Everything operates on actual pixels.
 */

export interface DecodedImage {
  /** In-memory canvas with the image, longest edge capped at MAX_EDGE. */
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

export const MAX_EDGE = 1600;

/** Decode a File/Blob and downscale so the longest edge is <= MAX_EDGE. */
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

/** Encode a canvas as a base64 JPEG data URL. */
export function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.9): string {
  return canvas.toDataURL('image/jpeg', quality);
}

/** Strip the data-URL prefix, leaving pure base64 (for JSON payloads). */
export function dataUrlToBase64(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(',');
  return commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
}

/** Small JPEG data URL for history thumbnails. */
export function makeThumbnail(canvas: HTMLCanvasElement, maxEdge = 320): string {
  const scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  const thumb = document.createElement('canvas');
  thumb.width = Math.max(1, Math.round(canvas.width * scale));
  thumb.height = Math.max(1, Math.round(canvas.height * scale));
  thumb.getContext('2d')?.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL('image/jpeg', 0.7);
}

/** Rotate a canvas by 90° clockwise (blister strips often print text sideways). */
export function rotate90(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const rotated = document.createElement('canvas');
  rotated.width = canvas.height;
  rotated.height = canvas.width;
  const ctx = rotated.getContext('2d');
  if (ctx) {
    ctx.translate(rotated.width / 2, rotated.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  }
  return rotated;
}

export interface Band {
  /** 1-based index in scan order. */
  index: number;
  /** Crop of the band, in original-orientation pixels. */
  canvas: HTMLCanvasElement;
  /** Vertical extent of the band in the source image. */
  y0: number;
  y1: number;
  /** Extra height this band shares with its neighbor (overlap). */
  overlapPx: number;
}

/**
 * Split an image into horizontal bands (top to bottom) with ~15% overlap
 * so text spanning band boundaries is read at least once fully.
 */
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
    crop
      .getContext('2d')
      ?.drawImage(image, 0, y0, image.width, cropHeight, 0, 0, image.width, cropHeight);
    bands.push({ index: bands.length + 1, canvas: crop, y0, y1, overlapPx });
  }

  return bands;
}

/**
 * Estimate blur via variance of the Laplacian (normalized by brightness).
 * Lower = blurrier. ~<0.003 usually means text is unreadable.
 */
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
      // 4-neighbor Laplacian
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  const variance = sumSq / count - (sum / count) ** 2;
  return variance;
}
