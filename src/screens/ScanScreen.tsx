import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera, HelpCircle, Info, QrCode, Shield, Upload, X } from 'lucide-react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Modal } from '../components/Modal';
import { useCamera } from '../hooks/useScan';
import { decodeLiveFrame } from '../services/barcode';
import type { ScanProgress } from '../services/scanPipeline';
import { disclaimerText, emergencyWarning } from '../data/content';
import type { CaptureSource } from '../types';

interface ScanScreenProps {
  onScanComplete: (file: File, source: CaptureSource) => void;
  isAnalyzing: boolean;
  progress: ScanProgress | null;
  scanError: string | null;
  onDismissScanError: () => void;
}

/** Wrap a canvas blob as a File so the pipeline receives real image bytes. */
async function canvasToFile(canvas: HTMLCanvasElement): Promise<File> {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error('Could not capture the image.');
  return new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
}

export function ScanScreen({
  onScanComplete,
  isAnalyzing,
  progress,
  scanError,
  onDismissScanError,
}: ScanScreenProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [cameraMode, setCameraMode] = useState<'photo' | 'code' | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [codeHint, setCodeHint] = useState('Point the camera at the QR or barcode on the pack');
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [showGuidance, setShowGuidance] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  /** Latest open mode; lets the unmount cleanup stop the stream reliably. */
  const modeRef = useRef<'photo' | 'code' | null>(null);

  const { stream, requestPermission, stopCamera, switchCamera } = useCamera();
  const isScanning = isAnalyzing;

  // Attach the stream when the dialog opens with a live stream present.
  useEffect(() => {
    const video = videoRef.current;
    if (cameraMode && stream && video) {
      video.srcObject = stream;
      setCameraReady(false);
      const onReady = () => setCameraReady(true);
      video.addEventListener('loadeddata', onReady);
      video.play().catch(() => {});
      if (video.readyState >= 2) setCameraReady(true);
      return () => video.removeEventListener('loadeddata', onReady);
    }
  }, [cameraMode, stream]);

  // Stop the camera when the dialog closes (intentional close, not re-render).
  useEffect(() => {
    modeRef.current = cameraMode;
    if (cameraMode === null) stopCamera();
  }, [cameraMode, stopCamera]);

  // Safety net: if the component unmounts while the dialog is open.
  useEffect(
    () => () => {
      if (modeRef.current !== null) stopCamera();
    },
    [stopCamera]
  );

  // Live 'Scan code' loop: decode the current video frame periodically.
  useEffect(() => {
    if (cameraMode !== 'code') return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      const video = videoRef.current;
      if (video && video.readyState >= 2) {
        try {
          const [code] = await decodeLiveFrame(video);
          if (cancelled) return;
          if (code) {
            setCodeHint(`Found ${code.format}: ${code.payload.slice(0, 48)}${code.payload.length > 48 ? '…' : ''}`);
            return; // stop scanning once a code is found
          }
        } catch {
          // frame decode hiccup — keep looping
        }
      }
      if (!cancelled) timer = window.setTimeout(tick, 350);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [cameraMode]);

  // Keep the newest progress line visible in the live feed.
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [progress?.message]);

  /** Where the pending image came from; set at adoption time, not sniffed later. */
  const lastCaptureSource = useRef<CaptureSource>('upload');

  const adoptFile = useCallback((file: File, source: CaptureSource) => {
    if (!file.type.startsWith('image/')) {
      setCaptureError('Please select an image file.');
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setCaptureError('Image size must be less than 15MB.');
      return;
    }
    lastCaptureSource.current = source;
    setPreviewUrl(URL.createObjectURL(file));
    setPendingFile(file);
    setCaptureError(null);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) adoptFile(file, 'upload');
      e.target.value = '';
    },
    [adoptFile]
  );

  const handleOpenCamera = useCallback(
    async (mode: 'photo' | 'code') => {
      setCaptureError(null);
      setCodeHint('Point the camera at the QR or barcode on the pack');
      setCameraMode(mode);
      try {
        await requestPermission();
      } catch {
        setCaptureError('Camera access denied. Upload an image instead, or enable camera permissions in your browser settings.');
        setCameraMode(null);
      }
    },
    [requestPermission]
  );

  const handleCameraCapture = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    // Wait (briefly) for the stream to actually have frame data.
    if (!video.videoWidth || video.readyState < 2) {
      const gotFrames = await Promise.race([
        new Promise<boolean>(resolve => {
          const onReady = () => resolve(true);
          video.addEventListener('loadeddata', onReady, { once: true });
          window.setTimeout(() => resolve(video.videoWidth > 0), 2500);
        }),
      ]);
      if (!gotFrames) {
        setCaptureError('Camera is not ready yet — try again in a moment.');
        return;
      }
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')?.drawImage(video, 0, 0);
      const file = await canvasToFile(canvas);
      adoptFile(file, 'camera');
      setCameraMode(null);
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : 'Capture failed.');
    }
  }, [adoptFile]);

  const handleRetake = useCallback(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setPendingFile(null);
    lastCaptureSource.current = 'upload';
  }, [previewUrl]);

  const handleScan = useCallback(() => {
    if (!pendingFile || isScanning) return;
    onScanComplete(pendingFile, lastCaptureSource.current);
  }, [pendingFile, isScanning, onScanComplete]);

  const scanLineTop = progress ? Math.min(100, Math.max(0, progress.scanLinePct)) : 0;

  if (cameraMode) {
    const isCodeMode = cameraMode === 'code';
    return (
      <div className="fixed inset-0 z-50 bg-black flex flex-col" role="dialog" aria-modal="true" aria-label={isCodeMode ? 'Scan code' : 'Camera'}>
        <div className="flex items-center justify-between p-4 bg-black/80">
          <h2 className="text-white font-medium">{isCodeMode ? 'Scan Code' : 'Capture Medicine Package'}</h2>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => void switchCamera()} aria-label="Switch camera">
              <span className="text-white">⟳</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCameraMode(null)} aria-label="Close camera">
              <X size={20} className="text-white" />
            </Button>
          </div>
        </div>

        <div className="flex-1 relative flex items-center justify-center">
          <video ref={videoRef} autoPlay playsInline muted className="max-w-full max-h-full" aria-label="Camera preview" />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="relative w-[80%] aspect-[4/3] border-2 border-white/60 rounded-xl">
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-black/80 px-3 py-1 rounded-full text-white text-sm font-medium whitespace-nowrap">
                {isCodeMode ? 'Hold steady over the code' : 'Align package within frame'}
              </div>
            </div>
          </div>
          {!cameraReady && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60">
              <p className="text-white text-sm animate-pulse">Starting camera…</p>
            </div>
          )}
        </div>

        {isCodeMode && (
          <div className="px-4 py-2 bg-black/80 text-center">
            <p className="text-primary-300 text-sm font-mono" aria-live="polite">{codeHint}</p>
          </div>
        )}

        <div className="flex items-center justify-center gap-6 p-6 bg-black/80">
          {!isCodeMode && (
            <Button
              variant="primary"
              size="lg"
              onClick={() => void handleCameraCapture()}
              disabled={!cameraReady}
              className="w-20 h-20 rounded-full p-0"
              aria-label="Capture photo"
            >
              <span className="block w-12 h-12 rounded-full border-4 border-white/80 bg-white/10">
                <span className="mx-auto mt-3 block w-5 h-5 rounded-full bg-white" />
              </span>
            </Button>
          )}
          <Button variant="ghost" size="lg" onClick={() => setShowGuidance(true)} aria-label="Photography guidance">
            <span className="text-white text-sm">Help</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 safe-area-inset-bottom">
      <header className="bg-white border-b border-gray-100 sticky top-0 z-40">
        <div className="max-w-md mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-900">PharmaTrace</h1>
          <Button variant="ghost" size="sm" onClick={() => setShowDisclaimer(true)} aria-label="Disclaimer information">
            <Info size={20} />
          </Button>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 py-6 pb-20">
        {!isScanning && (
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary-100 text-primary-600 mb-4">
              <Shield size={32} aria-hidden="true" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900">Scan Medicine Package</h2>
            <p className="mt-2 text-gray-600">Take a photo or upload an image — text is read on-device or via a vision model</p>
          </div>
        )}

        {(captureError || scanError) && !isScanning && (
          <div className="mb-4 p-3 rounded-xl bg-danger-50 border border-danger-200 flex items-start gap-3" role="alert">
            <AlertTriangle size={20} className="text-danger-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <p className="text-sm text-danger-700">{scanError ?? captureError}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCaptureError(null);
                if (scanError) onDismissScanError();
              }}
              className="ml-auto"
              aria-label="Dismiss error"
            >
              <X size={16} />
            </Button>
          </div>
        )}

        {!previewUrl && !isScanning && (
          <div className="space-y-4">
            <Button variant="primary" fullWidth size="lg" onClick={() => void handleOpenCamera('photo')} className="h-16">
              <Camera size={20} />
              Take Photo
            </Button>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="bg-gray-50 px-4 text-gray-500">or</span>
              </div>
            </div>
            <Button variant="secondary" fullWidth size="lg" onClick={() => fileInputRef.current?.click()} className="h-16">
              <Upload size={20} />
              Upload Image
            </Button>
            <Button variant="secondary" fullWidth size="lg" onClick={() => void handleOpenCamera('code')} className="h-16">
              <QrCode size={20} />
              Scan Code (live)
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileSelect}
              className="hidden"
              id="file-upload"
              aria-label="Upload medicine package image"
            />
            <Button variant="ghost" fullWidth onClick={() => setShowGuidance(true)}>
              <HelpCircle size={20} />
              Photography Guidance
            </Button>
          </div>
        )}

        {previewUrl && !isScanning && (
          <Card variant="elevated" className="animate-slide-up">
            <div className="relative aspect-[4/3] rounded-xl overflow-hidden bg-gray-100 mb-4">
              <img src={previewUrl} alt="Medicine package to analyze" className="w-full h-full object-contain" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">{pendingFile?.name ?? 'Image ready'}</span>
              <Button variant="ghost" size="sm" onClick={handleRetake}>
                Retake
              </Button>
            </div>
            <Button variant="primary" fullWidth size="lg" onClick={handleScan} className="mt-4">
              Analyze Package
            </Button>
          </Card>
        )}

        {isScanning && previewUrl && (
          <Card variant="elevated" className="animate-fade-in">
            <div className="relative rounded-xl overflow-hidden bg-gray-900 mb-4">
              <img src={previewUrl} alt="Scanning medicine package" className="w-full max-h-[420px] object-contain" />
              {/* Completed OCR runs get a thin progress strip tint. */}
              {progress && progress.completedRuns.length > 0 && (
                <div
                  className="absolute left-0 right-0 top-0 bg-primary-400/15 border-b border-primary-300/30 transition-[height] duration-300"
                  style={{ height: `${(progress.completedRuns.length / Math.max(1, progress.totalRuns)) * 100}%` }}
                  aria-hidden="true"
                />
              )}
              {/* Scan line follows real analysis progress. */}
              <div
                className="absolute left-0 right-0 h-[3px] bg-primary-400 shadow-[0_0_12px_2px_rgba(74,222,128,0.8)]"
                style={{ top: `${scanLineTop}%` }}
                role="presentation"
              >
                <div className="absolute inset-x-0 -top-2 h-2 bg-gradient-to-b from-transparent to-primary-400/30" />
              </div>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-gray-900">{progress?.message ?? 'Preparing…'}</span>
              <span className="text-gray-500">{Math.round(scanLineTop)}%</span>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full bg-primary-500 transition-[width] duration-300" style={{ width: `${scanLineTop}%` }} />
            </div>

            {/* Live feed of band findings. */}
            <div
              ref={feedRef}
              className="mt-4 h-28 overflow-y-auto rounded-xl bg-gray-950 p-3 font-mono text-xs leading-relaxed text-primary-300"
              aria-live="polite"
              aria-label="Live scan feed"
            >
              <ScanFeedLines progress={progress} />
            </div>
          </Card>
        )}

        <div className="mt-8 space-y-3">              <Card variant="outlined" padding="sm">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary-100 flex items-center justify-center flex-shrink-0">
                <Shield size={18} className="text-primary-600" />
              </div>
              <div>
                <h3 className="font-medium text-gray-900">How your photo is analyzed</h3>
                <p className="text-sm text-gray-500 mt-1">
                  Your image is sent to a vision model when the server has an API key configured; otherwise text is
                  read on this device with OCR. Either way, only text actually visible in the photo is extracted —
                  unreadable fields are left blank, never guessed.
                </p>
              </div>
            </div>
          </Card>
          <Card variant="outlined" padding="sm">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-warning-100 flex items-center justify-center flex-shrink-0">
                <AlertTriangle size={18} className="text-warning-600" />
              </div>
              <div>
                <h3 className="font-medium text-gray-900">Not a Medical Device</h3>
                <p className="text-sm text-gray-500 mt-1">{emergencyWarning}</p>
              </div>
            </div>
          </Card>
        </div>
      </main>

      <Modal isOpen={showDisclaimer} onClose={() => setShowDisclaimer(false)} title="Important Disclaimer" size="lg">
        <div className="space-y-4 text-sm text-gray-600 max-h-[60vh] overflow-y-auto">
          <p className="font-medium text-gray-900">{emergencyWarning}</p>
          <p>{disclaimerText}</p>
          <Button variant="primary" fullWidth onClick={() => setShowDisclaimer(false)}>
            I Understand
          </Button>
        </div>
      </Modal>

      <Modal isOpen={showGuidance} onClose={() => setShowGuidance(false)} title="Photography Guidance" size="lg">
        <div className="space-y-6 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-4">
            {[
              { title: 'Good Lighting', desc: 'Use bright, even light. Avoid flash glare.' },
              { title: 'Flat Surface', desc: 'Lay the strip flat. Include batch, EXP, MRP.' },
              { title: 'Straight Angle', desc: 'Hold the camera parallel to the print.' },
              { title: 'Text in Focus', desc: 'Blurry text will read as low confidence.' },
              { title: 'Sideways Print', desc: 'Blister strips often print batch/expiry rotated — the scanner checks 90° too.' },
              { title: 'Full Panel', desc: 'Capture the whole label, edges included.' },
            ].map(item => (
              <Card key={item.title} variant="outlined" padding="md">
                <h4 className="font-medium text-gray-900">{item.title}</h4>
                <p className="text-sm text-gray-500 mt-1">{item.desc}</p>
              </Card>
            ))}
          </div>
          <Button variant="primary" fullWidth onClick={() => setShowGuidance(false)}>
            Got It
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** Live feed of OCR runs, derived from real progress events. */
function ScanFeedLines({ progress }: { progress: ScanProgress | null }) {
  if (!progress) return <div>&gt; waiting for image…</div>;
  const lines: string[] = ['> preparing image…'];
  for (const run of progress.completedRuns) {
    lines.push(`> ${run}: done`);
  }
  if (progress.phase === 'bands' || progress.phase === 'variants') {
    lines.push(`> ${progress.message}`);
    for (const found of progress.lastRunLines) {
      if (found) lines.push(`    "${found.trim()}"`);
    }
  }
  if (progress.phase === 'merging') lines.push('> merging overlapping reads…');
  if (progress.phase === 'extracting') lines.push('> extracting fields…');
  return (
    <>
      {lines.map((line, i) => (
        <div key={`${i}-${line}`}>{line}</div>
      ))}
    </>
  );
}
