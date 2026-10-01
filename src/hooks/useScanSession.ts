import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  BBox,
  CaptureSource,
  CheckResult,
  ExtractedData,
  ExtractedFields,
  ExtractionField,
  FieldCandidate,
  FieldKey,
  RiskLevel,
  ScanResult,
  SessionPhoto,
  TextLine,
} from '../types';
import { BLOCKING_KEYS, COLLECTION_STEPS } from '../types';
import { runScan, ScanError, type ScanProgress } from '../services/scanPipeline';
import { computeScanQuality } from '../utils/checks';
import { generateId } from '../utils/helpers';
import { classifyComposition, identifyProduct, lookupBatchInfo, lookupProductInfo } from '../services/identify';
import { joinRawText } from '../services/extract';
import { verify } from '../services/verifier';

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
  userTypedName: string | null,
  sessionLines: TextLine[]
): ScanResult {
  // Try to match the product from the dataset using both structured fields
  // and raw OCR lines — this works even when the parser extracted nothing.
  const productInfo = lookupProductInfo(fields, firstPass.data.allOcrLines ?? firstPass.data.rawTextLines);

  // If the dataset matched, patch any missing structured fields from it so the
  // result screen always has something to show.
  const patchedFields = productInfo
    ? patchFieldsFromDataset(fields, productInfo)
    : fields;

  // rawText from ALL photos in this session: a second photo of the sideways
  // edge adds its text to the first photo's text.
  const lines = sessionLines.length > 0 ? sessionLines : firstPass.data.rawTextLines;
  const data: ExtractedData = {
    ...firstPass.data,
    fields: patchedFields,
    rawTextLines: lines,
    allOcrLines: sessionLines.length > 0 ? sessionLines : firstPass.data.allOcrLines ?? firstPass.data.rawTextLines,
    rawText: joinRawText(lines),
  };

  // The verify.js result drives the whole results screen: label, confidence,
  // counts and the checks list. No counts outside result.checks.
  const verification = verify({
    rawText: data.rawText,
    fields: {
      batch: patchedFields.batch_no?.value ?? '',
      mfg: patchedFields.mfg_date?.value ?? '',
      exp: patchedFields.expiry_date?.value ?? '',
      manufacturer: patchedFields.manufacturer_name?.value ?? patchedFields.marketer_name?.value ?? '',
      brand: patchedFields.brand_name?.value ?? '',
      composition: patchedFields.composition?.value ?? '',
      dosageForm: patchedFields.dosage_form?.value ?? '',
      mfgLicence: patchedFields.manufacturing_license_no?.value ?? '',
    },
  });
  const checks: CheckResult[] = verification.checks.map((check, index) => ({
    id: `verify-${index}`,
    name: check.name,
    status: check.status,
    reason: check.reason,
  }));

  const identification = identifyProduct(patchedFields, data.codes, data.rawTextLines, userTypedName ?? undefined);
  return {
    id: generateId(),
    timestamp: new Date().toISOString(),
    imageUrl: firstPass.imageUrl,
    captureSource: firstPass.captureSource,
    analyzer: firstPass.analyzer,
    riskLevel: verification.riskLevel,
    extractedData: data,
    checks,
    verification,
    scanQuality: computeScanQuality(data, skippedFields.length, userEnteredFields.length),
    imageWidth: firstPass.imageWidth,
    imageHeight: firstPass.imageHeight,
    photos,
    skippedFields,
    userEnteredFields,
    identification,
    drugClass: classifyComposition(patchedFields.composition?.value),
    batchInfo: patchedFields.batch_no
      ? lookupBatchInfo(patchedFields.batch_no.value, patchedFields.manufacturer_name?.value ?? patchedFields.marketer_name?.value)
      : null,
    productInfo,
  };
}

/** Fill any null/low-confidence structured fields from the matched dataset entry. */
function patchFieldsFromDataset(
  fields: ExtractedFields,
  info: import('../types').ProductInfo
): ExtractedFields {
  const patched = { ...fields };

  const datasetField = (value: string): import('../types').ExtractionField => ({
    value,
    confidence: 'medium' as const,
    origin: 'image' as const,
    grounded: true,
    fromReference: true,
    matchQuality: 'strict' as const,
    provenance: { matchedText: value, runLabel: 'dataset-match' },
  });

  if (!patched.brand_name?.value) {
    patched.brand_name = datasetField(info.brand);
  }
  if (!patched.composition?.value) {
    const comp = info.ingredients.map(i => `${i.name} ${i.strengthMg}mg`).join(' + ');
    patched.composition = datasetField(comp);
  }
  if (!patched.manufacturer_name?.value) {
    patched.manufacturer_name = datasetField(info.manufacturerDisplay);
  }
  if (!patched.dosage_form?.value) {
    patched.dosage_form = datasetField(info.dosageForm);
  }

  return patched;
}
/**
 * Keys are "missing" only if they have no field AND no pending candidate.
 * A candidate is not missing — it is waiting for confirmation and must NOT
 * trigger a new photo step.
 */
export function missingTargets(
  fields: ExtractedFields,
  keys: FieldKey[],
  candidates: FieldCandidate[] = []
): FieldKey[] {
  const candidateKeys = new Set(candidates.map(c => c.key));
  return keys.filter(key => {
    const f = fields[key];
    if (candidateKeys.has(key)) return false;   // has a candidate → not missing
    return !f || f.confidence === 'low';
  });
}

/** A value being entered or corrected manually. */
export function userField(value: string): ExtractionField {
  return { value: value.trim(), confidence: 'low', origin: 'user' };
}

/** What startScan resolves to: the pipeline result plus where the session went. */
export interface StartScanOutcome {
  result: Omit<ScanResult, 'photos' | 'skippedFields' | 'userEnteredFields' | 'identification' | 'drugClass' | 'batchInfo' | 'productInfo' | 'verification'>;
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
  /** Every OCR line from ALL photos this session — rawText grows per photo. */
  const [sessionLines, setSessionLines] = useState<TextLine[]>([]);
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
    setSessionLines([]);
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

        // ── Debug log: Step 1 – raw text ──────────────────────────────────
        console.log('[session] raw text lines', result.extractedData.rawTextLines.map(l => l.text));

        // ── Debug log: Step 2 – parsed fields ─────────────────────────────
        console.log('[session] parsed fields from first scan', Object.fromEntries(
          (Object.keys(result.extractedData.fields) as FieldKey[]).map(k => [k, result.extractedData.fields[k]?.value ?? null])
        ));
        console.log('[session] candidates from first scan', result.extractedData.candidates.map(c => `${c.key}=${c.value} (${c.reason})`));

        const photo: SessionPhoto = {
          id: `photo-${result.id}`,
          dataUrl: result.imageUrl,
          label: 'Front of pack',
          addedAt: result.timestamp,
        };
        const mergedFields = mergeFields(emptyFields(), result.extractedData.fields);
        setPhotos([photo]);
        setFields(mergedFields);
        // Second photo of the sideways edge adds to the first photo's text.
        setSessionLines(result.extractedData.rawTextLines);
        setFirstPass({
          data: result.extractedData,
          imageUrl: result.imageUrl,
          captureSource: source,
          analyzer: result.analyzer,
          imageWidth: result.imageWidth,
          imageHeight: result.imageHeight,
          checks: result.checks,
        });

        const blocking = missingTargets(result.extractedData.fields, BLOCKING_KEYS, result.extractedData.candidates);

        // ── Debug log: Step 3 – what goes to CollectScreen ─────────────────
        console.log('[session] → CollectScreen: collectedFields', Object.fromEntries(
          (Object.keys(mergedFields) as FieldKey[]).map(k => [k, mergedFields[k]?.value ?? null])
        ));
        console.log('[session] → CollectScreen: blockingMissing', blocking);
        console.log('[session] → CollectScreen: candidates to confirm', result.extractedData.candidates.length);

        // If a product from the dataset was matched using the raw OCR text,
        // skip the collect screen entirely and go straight to results.
        const allLines = result.extractedData.allOcrLines ?? result.extractedData.rawTextLines;
        const datasetMatch = lookupProductInfo(mergedFields, allLines);
        const skipCollect = blocking.length === 0 || datasetMatch !== null;

        if (skipCollect) {
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
            userTypedName.current,
            result.extractedData.rawTextLines
          );
          console.log('[session] stage → done', datasetMatch ? `(dataset match: ${datasetMatch.brand})` : '(all blocking fields present)');
          return { result, stage: 'done', final };
        }
        setStage('collecting');
        console.log('[session] stage → collecting');
        return { result, stage: 'collecting', final: null };
      } catch (err) {
        const message =
          err instanceof ScanError ? err.message : 'Could not analyze image. Please try a different photo.';
        console.error('[session] scan failed:', err);
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
        setSessionLines(prev => [...prev, ...result.extractedData.rawTextLines]);
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
        setSessionLines(prev => [...prev, ...result.extractedData.rawTextLines]);
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

  /** Promote a candidate to a confirmed field.  The value may be edited. */
  const confirmCandidate = useCallback((key: FieldKey, value: string) => {
    if (!value.trim()) return;
    console.log('[session] confirmCandidate', key, value);
    setFields(prev => ({
      ...prev,
      [key]: {
        value: value.trim(),
        confidence: 'high',
        origin: 'image',
        grounded: true,
        confirmedByUser: true,
        matchQuality: 'strict',
      },
    }));
    setUserEnteredFields(prev => (prev.includes(key) ? prev : [...prev, key]));
  }, []);

  const skipStep = useCallback((stepId: string) => {
    const step = COLLECTION_STEPS.find(s => s.id === stepId);
    if (!step) return;
    setSkippedFields(prev => [...new Set([...prev, ...step.keys])]);
  }, []);

  /** Which steps still have missing targets (keys with no field AND no candidate). */
  const pendingGroups = useMemo<MissingGroup[]>(() => {
    const candidates = firstPass?.data.candidates ?? [];
    return COLLECTION_STEPS.map(step => {
      const missing = missingTargets(fields, step.keys, candidates);
      return { stepId: step.id, title: step.title, instruction: step.instruction, keys: step.keys, missing };
    }).filter(group => group.missing.length > 0);
  }, [fields, firstPass]);

  /** Build the final result from everything collected so far. */
  const finish = useCallback((): ScanResult | null => {
    if (!firstPass) return null;
    return assembleResult(firstPass, fields, photos, skippedFields, userEnteredFields, userTypedName.current, sessionLines);
  }, [firstPass, fields, photos, skippedFields, userEnteredFields, sessionLines]);

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
    confirmCandidate,
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
