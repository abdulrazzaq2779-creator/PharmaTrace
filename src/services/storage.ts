import type { AppSettings, ScanResult } from '../types';
import { defaultSettings } from '../types';

const SCAN_RESULTS_KEY = 'pharmatrace-scan-results';
const SETTINGS_KEY = 'pharmatrace-settings';

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    if (isQuotaError(error)) {
      throw new StorageError(
        'Local storage is full — delete older scans to keep saving new ones.'
      );
    }
    throw new StorageError('Could not save data locally.');
  }
}

/** Defensive load: skip malformed entries and backfill fields added later. */
export function loadScanResults(): ScanResult[] {
  const raw = readJson<ScanResult[]>(SCAN_RESULTS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is ScanResult =>
        typeof item?.id === 'string' &&
        typeof item?.timestamp === 'string' &&
        typeof item?.imageUrl === 'string' &&
        Array.isArray(item?.checks) &&
        typeof item?.extractedData === 'object'
    )
    .map(item => ({
      ...item,
      photos: Array.isArray(item.photos) ? item.photos : [],
      skippedFields: Array.isArray(item.skippedFields) ? item.skippedFields : [],
      userEnteredFields: Array.isArray(item.userEnteredFields) ? item.userEnteredFields : [],
      // Fields added after the first release — absent in older saved scans.
      identification: item.identification ?? null,
      drugClass: item.drugClass ?? null,
      batchInfo: item.batchInfo ?? null,
      extractedData: { ...item.extractedData, codes: item.extractedData.codes ?? [] },
    }));
}

export function saveScanResults(results: ScanResult[]): void {
  writeJson(SCAN_RESULTS_KEY, results);
}

export function loadSettings(): AppSettings {
  return { ...defaultSettings, ...readJson<Partial<AppSettings>>(SETTINGS_KEY) };
}

export function saveSettings(settings: AppSettings): void {
  writeJson(SETTINGS_KEY, settings);
}


