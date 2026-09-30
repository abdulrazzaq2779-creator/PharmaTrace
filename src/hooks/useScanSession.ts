import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  BBox,
  CaptureSource,
  CheckResult,
  ExtractedData,
  ExtractedFields,
  ExtractionField,
  FieldKey,
  RiskLevel,
  ScanResult,
  SessionPhoto,
} from '../types';
import { BLOCKING_KEYS, COLLECTION_STEPS } from '../types';
import { runScan, ScanError, type ScanProgress } from '../services/scanPipeline';
import { computeOverall, computeScanQuality, runChecks } from '../utils/checks';
import { generateId } from '../utils/helpers';
import { classifyComposition, identifyProduct, lookupBatchInfo } from '../services/identify';

export type SessionStage = 'idle' | 'analyzing' | 'collecting' | 'done';

const CONF_RANK: Record<string, number> = { high: 4, medium: 3, low: 2, user: 1 };

function rankOf(field: ExtractionField): number {
  return field.origin === 'user' ? CONF_RANK.user : CONF_RANK[field.confidence];
}

/** Merge without downgrade: a higher-confidence read replaces; equal keeps the first. */
export function mergeField(existing: ExtractionField | null, incoming: ExtractionField): ExtractionField {
  if (!existing) return incoming;
  return rankOf(incoming) > rankOf(existing) ? incoming : existing;
}

export function mergeFields(base: ExtractedFields, incoming: ExtractedFields): ExtractedFields {
  const merged = { ...base };
  for (const key of Object.keys(merged) as FieldKey[]) {
    const value = incoming[key];
    if (value) merged[key] = mergeField(merged[key], value);
  }
  return merged;
}

interface FirstPass {
  data: ExtractedData;
  imageUrl: string;
  captureSource: CaptureSource;
  analyzer: ScanResult['analyzer'];
  imageWidth: number;
  imageHeight: number;
}

/** Build a final ScanResult from session pieces (used by startScan and finish). */
function assembleResult(
  firstPass: FirstPass,
  fields: ExtractedFields,
  photos: SessionPhoto[],
  skippedFields: FieldKey[],
  userEnteredFields: FieldKey[],
  userTypedName: string | null
): ScanResult {
  const data: ExtractedData = { ...firstPass.data, fields };
  const checks = runChecks(data);
  const identification = identifyProduct(fields, data.codes, data.rawTextLines, userTypedName ?? undefined);
  return {
    id: generateId(),
    timestamp: new Date().toISOString(),
    imageUrl: firstPass.imageUrl,
    captureSource: firstPass.captureSource,
    analyzer: firstPass.analyzer,
    riskLevel: computeOverall(checks),
    extractedData: data,
    checks,
    scanQuality: computeScanQuality(data, skippedFields.length, userEnteredFields.length),
    imageWidth: firstPass.imageWidth,
    imageHeight: firstPass.imageHeight,
    photos,
    skippedFields,
    userEnteredFields,
    identification,
    drugClass: classifyComposition(fields.composition?.value),
    batchInfo: fields.batch_no
      ? lookupBatchInfo(fields.batch_no.value, fields.manufacturer_name?.value ?? fields.marketer_name?.value)
      : null,
  };
}
export function missingTargets(fields: ExtractedFields, keys: FieldKey[]): FieldKey[] {
  return keys.filter(key => {
    const field = fields[key];
    return !field || field.confidence === 'low';
  });
}

/** A value being entered or corrected manually. */
export function userField(value: string): ExtractionField {
  return { value: value.trim(), confidence: 'low', origin: 'user' };
}

/** What startScan resolves to: the pipeline result plus where the session went. */
export interface StartScanOutcome {
  result: Omit<ScanResult, 'photos' | 'skippedFields' | 'userEnteredFields' | 'identification' | 'drugClass' | 'batchInfo'>;
  stage: SessionStage;
  /** Fully-built ScanResult when the session went straight to 'done'. */
  final: ScanResult | null;
}

export interface MissingGroup {
  stepId: string;
  title: string;
  instruction: string;
  keys: FieldKey[];
  missing: FieldKey[];
}

export function useScanSession() {
  const [stage, setStage] = useState<SessionStage>('idle');
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<SessionPhoto[]>([]);
  const [fields, setFields] = useState<ExtractedFields>(emptyFields());
  const [skippedFields, setSkippedFields] = useState<FieldKey[]>([]);
  const [userEnteredFields, setUserEnteredFields] = useState<FieldKey[]>([]);
  const [firstPass, setFirstPass] = useState<
    {
      data: ExtractedData;
      imageUrl: string;
      captureSource: CaptureSource;
      analyzer: ScanResult['analyzer'];
      imageWidth: number;
      imageHeight: number;
      checks: CheckResult[];
    } | null
  >(null);
  /** Name the user typed for identification (fallback chain step e). */
  const userTypedName = useRef<string | null>(null);

  const reset = useCallback(() => {
    setStage('idle');
    setProgress(null);
    setError(null);
    setPhotos([]);
    setFields(emptyFields());
    setSkippedFields([]);
    setUserEnteredFields([]);
    setFirstPass(null);
    userTypedName.current = null;
  }, []);

  const runPhoto = useCallback(
    async (file: Blob, source: CaptureSource, label: string, crop?: BBox) => {
      const { result, raw } = await runScan({ file, source, crop, photoLabel: label }, setProgress);
      console.log('raw analyzer response (session photo)', label, raw);
      return result;
    },
    []
  );

  /** First scan of the session. Returns the outcome so callers never read stale stage state. */
  const startScan = useCallback(
    async (file: File, source: CaptureSource): Promise<StartScanOutcome | null> => {
      setStage('analyzing');
      setError(null);
      setProgress(null);
      try {
        const result = await runPhoto(file, source, file.name || 'first-photo');
        const photo: SessionPhoto = {
          id: `photo-${result.id}`,
          dataUrl: result.imageUrl,
          label: 'Front of pack',
          addedAt: result.timestamp,
        };
        const mergedFields = mergeFields(emptyFields(), result.extractedData.fields);
        setPhotos([photo]);
        setFields(mergedFields);
        setFirstPass({
          data: result.extractedData,
          imageUrl: result.imageUrl,
          captureSource: source,
          analyzer: result.analyzer,
          imageWidth: result.imageWidth,
          imageHeight: result.imageHeight,
          checks: result.checks,
        });

        const blocking = missingTargets(result.extractedData.fields, BLOCKING_KEYS);
        if (blocking.length === 0) {
          setStage('done');
          const final = assembleResult(
            {
              data: result.extractedData,
              imageUrl: result.imageUrl,
              captureSource: source,
              analyzer: result.analyzer,
              imageWidth: result.imageWidth,
              imageHeight: result.imageHeight,
            },
            mergedFields,
            [photo],
            [],
            [],
            userTypedName.current
          );
          return { result, stage: 'done', final };
        }
        setStage('collecting');
        return { result, stage: 'collecting', final: null };
      } catch (err) {
        const message =
          err instanceof ScanError ? err.message : 'Could not analyze image. Please try a different photo.';
        console.error('scan failed:', err);
        setError(message);
        setStage('idle');
        return null;
      }
    },
    [runPhoto]
  );

  /** Add a follow-up photo for a collection step; merge without downgrade. */
  const addPhoto = useCallback(
    async (file: File, stepId: string) => {
      const step = COLLECTION_STEPS.find(s => s.id === stepId);
      if (!step) return;
      setStage('analyzing');
      setError(null);
      try {
        const result = await runPhoto(file, 'camera', `${step.title} photo`);
        const photo: SessionPhoto = {
          id: `photo-${result.id}`,
          dataUrl: result.imageUrl,
          label: step.title,
          addedAt: result.timestamp,
        };
        setPhotos(prev => [...prev, photo]);
        setFields(prev => {
          const merged = mergeFields(prev, result.extractedData.fields);
          console.log(
            'merged fields after',
            step.id,
            Object.fromEntries(step.keys.map(k => [k, merged[k]?.value ?? null]))
          );
          return merged;
        });
        setStage('collecting');
        return result;
      } catch (err) {
        const message = err instanceof ScanError ? err.message : 'Could not analyze image. Try again.';
        setError(message);
        setStage('collecting');
        return null;
      }
    },
    [runPhoto]
  );

  /** Re-run extraction on a cropped region of an existing photo. */
  const rescanCrop = useCallback(
    async (photoId: string, crop: BBox, stepId?: string) => {
      const photo = photos.find(p => p.id === photoId);
      if (!photo) return;
      setStage('analyzing');
      setError(null);
      try {
        const blob = await (await fetch(photo.dataUrl)).blob();
        const result = await runPhoto(blob, 'camera', `crop of ${photo.label}`, crop);
        if (stepId) {
          const step = COLLECTION_STEPS.find(s => s.id === stepId);
          setFields(prev => {
            const merged = mergeFields(prev, result.extractedData.fields);
            console.log('merged fields after crop rescan', stepId, Object.fromEntries((step?.keys ?? []).map(k => [k, merged[k]?.value ?? null])));
            return merged;
          });
        } else {
          setFields(prev => mergeFields(prev, result.extractedData.fields));
        }
        setStage('collecting');
        return result;
      } catch (err) {
        const message = err instanceof ScanError ? err.message : 'Could not analyze the cropped region.';
        setError(message);
        setStage('collecting');
        return null;
      }
    },
    [photos, runPhoto]
  );

  const enterManually = useCallback((key: FieldKey, value: string) => {
    if (!value.trim()) return;
    setFields(prev => ({ ...prev, [key]: userField(value) }));
    setUserEnteredFields(prev => (prev.includes(key) ? prev : [...prev, key]));
    if (key === 'brand_name') userTypedName.current = value.trim();
  }, []);

  const skipStep = useCallback((stepId: string) => {
    const step = COLLECTION_STEPS.find(s => s.id === stepId);
    if (!step) return;
    setSkippedFields(prev => [...new Set([...prev, ...step.keys])]);
  }, []);

  /** Which steps still have missing targets. */
  const pendingGroups = useMemo<MissingGroup[]>(() => {
    return COLLECTION_STEPS.map(step => {
      const missing = missingTargets(fields, step.keys);
      return { stepId: step.id, title: step.title, instruction: step.instruction, keys: step.keys, missing };
    }).filter(group => group.missing.length > 0);
  }, [fields]);

  /** Build the final result from everything collected so far. */
  const finish = useCallback((): ScanResult | null => {
    if (!firstPass) return null;
    return assembleResult(firstPass, fields, photos, skippedFields, userEnteredFields, userTypedName.current);
  }, [firstPass, fields, photos, skippedFields, userEnteredFields]);

  return {
    stage,
    progress,
    error,
    photos,
    fields,
    skippedFields,
    userEnteredFields,
    firstPass,
    pendingGroups,
    startScan,
    addPhoto,
    rescanCrop,
    enterManually,
    skipStep,
    finish,
    reset,
    setError,
  };
}

function emptyFields(): ExtractedFields {
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

export type { RiskLevel };
