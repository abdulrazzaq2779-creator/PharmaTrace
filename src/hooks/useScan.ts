import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanResult } from '../types';
import { loadScanResults, saveScanResults } from '../services/storage';

const MAX_HISTORY_ITEMS = 30;

/** Persisted scan results, capped and quota-safe (synchronous persistence). */
export function useScanHistory() {
  const [scanResults, setScanResults] = useState<ScanResult[]>(() => loadScanResults());
  const [historyError, setHistoryError] = useState<string | null>(null);
  const scanResultsRef = useRef(scanResults);

  const applyResults = useCallback((updater: (prev: ScanResult[]) => ScanResult[]) => {
    const next = updater(scanResultsRef.current);
    scanResultsRef.current = next;
    setScanResults(next);
    try {
      saveScanResults(next);
      setHistoryError(null);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Could not save scan history.');
    }
  }, []);

  const addScan = useCallback(
    (scan: ScanResult) => applyResults(prev => [scan, ...prev].slice(0, MAX_HISTORY_ITEMS)),
    [applyResults]
  );

  /** Add or replace by id, newest first, capped. */
  const upsertScan = useCallback(
    (scan: ScanResult) =>
      applyResults(prev => [scan, ...prev.filter(item => item.id !== scan.id)].slice(0, MAX_HISTORY_ITEMS)),
    [applyResults]
  );

  const deleteScan = useCallback(
    (id: string) => applyResults(prev => prev.filter(scan => scan.id !== id)),
    [applyResults]
  );

  const clearHistory = useCallback(() => applyResults(() => []), [applyResults]);

  return { scanResults, historyError, addScan, upsertScan, deleteScan, clearHistory };
}

export function useCamera() {
  const [permission, setPermission] = useState<'granted' | 'denied' | 'prompt'>('prompt');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('environment');
  const streamRef = useRef<MediaStream | null>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const requestPermission = useCallback(
    async (mode?: 'user' | 'environment') => {
      const facing = mode ?? facingMode;
      stopCamera();
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        streamRef.current = mediaStream;
        setStream(mediaStream);
        setPermission('granted');
        return mediaStream;
      } catch (err) {
        setPermission('denied');
        throw err;
      }
    },
    [facingMode, stopCamera]
  );

  const switchCamera = useCallback(async () => {
    const next = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(next);
    await requestPermission(next);
  }, [facingMode, requestPermission]);

  useEffect(() => stopCamera, [stopCamera]);

  return { permission, stream, facingMode, requestPermission, stopCamera, switchCamera };
}
