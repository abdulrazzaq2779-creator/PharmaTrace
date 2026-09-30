/**
 * Browser side of the codes round-trip test: renders generated QR canvases
 * plus a real-world DataMatrix image, runs the real decodeCodes() service
 * (native BarcodeDetector + zxing grid), and dumps results into the DOM for
 * headless verification.
 */
import { BarcodeFormat, QRCodeWriter } from '@zxing/library';
import { decodeCodes } from '../src/services/barcode';
import type { DecodedCode } from '../src/types';
import { DM_SAMPLE_DATA_URL } from './dm-sample-data';

async function init(): Promise<void> {
  const results: Array<{ name: string; codes: DecodedCode[] }> = [];

  function drawBitMatrix(
    matrix: { getWidth(): number; getHeight(): number; get(x: number, y: number): boolean },
    scale: number
  ): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = matrix.getWidth() * scale;
    canvas.height = matrix.getHeight() * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    for (let y = 0; y < matrix.getHeight(); y++) {
      for (let x = 0; x < matrix.getWidth(); x++) {
        if (matrix.get(x, y)) ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
    return canvas;
  }

  function rotateCanvas(source: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = source.height;
    out.height = source.width;
    const ctx = out.getContext('2d')!;
    if (degrees === 90) {
      ctx.translate(out.width, 0);
      ctx.rotate(Math.PI / 2);
    }
    ctx.drawImage(source, 0, 0);
    return out;
  }

  const qrWriter = new QRCodeWriter();
  const qrUrl = qrWriter.encode('https://verify.example-pharma.com/g/08712345000012', BarcodeFormat.QR_CODE, 120, 120, new Map());
  const qrGs1 = qrWriter.encode('(01)08712345000012(10)G652046(17)280331(21)S98765', BarcodeFormat.QR_CODE, 140, 140, new Map());

  const canvases: Array<{ name: string; canvas: HTMLCanvasElement }> = [
    { name: 'qr-url', canvas: drawBitMatrix(qrUrl, 4) },
    { name: 'qr-gs1', canvas: drawBitMatrix(qrGs1, 4) },
    { name: 'qr-gs1-rotated', canvas: rotateCanvas(drawBitMatrix(qrGs1, 4), 90) },
  ];

  // Real-world DataMatrix image (contains a GS1 element string with brackets).
  const dmImage = new Image();
  dmImage.src = DM_SAMPLE_DATA_URL;
  await new Promise<void>(resolve => {
    dmImage.onload = () => resolve();
    dmImage.onerror = () => resolve(); // continue even if the sample is missing
  });
  const dmCanvas = document.createElement('canvas');
  dmCanvas.width = dmImage.naturalWidth;
  dmCanvas.height = dmImage.naturalHeight;
  dmCanvas.getContext('2d')!.drawImage(dmImage, 0, 0);
  canvases.push({ name: 'dm-gs1-real', canvas: dmCanvas });

  try {
    for (const { name, canvas } of canvases) {
      document.body.appendChild(canvas);
      canvas.setAttribute('data-test-name', name);
      const codes = await decodeCodes(canvas);
      results.push({ name, codes });
    }
  } catch (err) {
    (window as unknown as { __codeError: unknown }).__codeError = String(err);
    const errPre = document.createElement('pre');
    errPre.id = 'code-error';
    errPre.textContent = `ERROR: ${String(err)}`;
    document.body.appendChild(errPre);
  }

  (window as unknown as { __codeResults: unknown }).__codeResults = results;

  const pre = document.createElement('pre');
  pre.id = 'code-results';
  pre.textContent = JSON.stringify(
    results.map(r => ({ name: r.name, codes: r.codes.map(c => ({ format: c.format, payload: c.payload, source: c.source })) })),
    null,
    1
  );
  document.body.appendChild(pre);
}

void init();
