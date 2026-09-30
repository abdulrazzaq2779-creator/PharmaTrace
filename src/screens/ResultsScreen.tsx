import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Crop,
  Download,
  HelpCircle,
  Info,
  Keyboard,
  MinusCircle,
  QrCode,
  RefreshCw,
  Share2,
  XCircle,
} from 'lucide-react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { Modal } from '../components/Modal';
import { Input } from '../components/Input';
import type { BBox, CheckResult, DecodedCode, FieldKey, ProductInfo, RiskLevel, ScanResult, SessionPhoto, TextLine } from '../types';
import { BLOCKING_KEYS } from '../types';
import { FIELD_LABELS, riskLevelDescriptions, riskLevelLabels } from '../data/content';
import { buildReportText } from '../utils/report';
import { formatDate, getRiskLevelColor } from '../utils/helpers';
import { applyManualEntry } from '../utils/resultEdits';
import { parseCodePayload } from '../services/barcode';

interface ResultsScreenProps {
  scanResult: ScanResult;
  onBack: () => void;
  onRescan: () => void;
  onShare: () => Promise<'shared' | 'copied'>;
  onSaveReport: (scan: ScanResult) => void;
  /** Manual entries/corrections applied to this result (recomputes checks + saves). */
  onApplyEdits?: (edited: ScanResult) => void;
  /** Follow-up crop rescans merge into the session (wired when opened from an active session). */
  onCropRescan?: (photoId: string, crop: BBox, stepId?: string) => void;
}

const RISK_BADGE_VARIANT: Record<RiskLevel, 'success' | 'warning' | 'danger'> = {
  consistent: 'success',
  'needs-review': 'warning',
  'high-risk': 'danger',
};

const RISK_ICONS: Record<RiskLevel, typeof CheckCircle> = {
  consistent: CheckCircle,
  'needs-review': HelpCircle,
  'high-risk': XCircle,
};

const CHECK_ICON = {
  pass: CheckCircle,
  fail: XCircle,
  review: HelpCircle,
  unavailable: MinusCircle,
} as const;

const CHECK_COLOR = {
  pass: 'text-primary-600',
  fail: 'text-danger-600',
  review: 'text-warning-600',
  unavailable: 'text-gray-400',
} as const;

const CHECK_BADGE = {
  pass: { variant: 'success', label: 'Pass' },
  fail: { variant: 'danger', label: 'Fail' },
  review: { variant: 'warning', label: 'Review' },
  unavailable: { variant: 'default', label: 'N/A' },
} as const;

const IDENTIFICATION_LABELS: Record<string, string> = {
  'code-gtin': 'QR/barcode (GTIN)',
  'code-url': 'QR/barcode (link)',
  composition: 'Composition',
  'fuzzy-brand': 'Brand name match',
  pill: 'Pill imprint',
  user: 'Entered by user',
};

/** Keys that get the smart "not visible" guidance when missing. */
const EDGE_PRINTED_KEYS: FieldKey[] = ['batch_no', 'mfg_date', 'expiry_date', 'mrp'];

const NOT_VISIBLE_MESSAGE =
  'Not visible in this image. Batch and expiry are usually printed on the crimped edge or the outer carton. Photograph that area.';

export function ResultsScreen({
  scanResult,
  onBack,
  onRescan,
  onShare,
  onSaveReport,
  onApplyEdits,
  onCropRescan,
}: ResultsScreenProps) {
  const [shareStatus, setShareStatus] = useState<'shared' | 'copied' | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [showRawList, setShowRawList] = useState(false);
  const [cropTarget, setCropTarget] = useState<{ photo: SessionPhoto } | null>(null);
  const [cropRect, setCropRect] = useState<BBox | null>(null);
  const [manualKey, setManualKey] = useState<FieldKey | null>(null);
  const [manualValue, setManualValue] = useState('');
  const [saved, setSaved] = useState(false);
  const [selectedLine, setSelectedLine] = useState<TextLine | null>(null);
  const [showBoxes, setShowBoxes] = useState(true);
  const [warnedUrl, setWarnedUrl] = useState<string | null>(null);
  const [openCode, setOpenCode] = useState<number | null>(null);

  const data = scanResult.extractedData;
  const RiskIcon = RISK_ICONS[scanResult.riskLevel];
  const riskColorClasses = getRiskLevelColor(scanResult.riskLevel);
  const [riskTextColor, riskBgColor, riskBorderColor] = riskColorClasses.split(' ');

  const counts = useMemo(
    () => ({
      passed: scanResult.checks.filter(c => c.status === 'pass').length,
      failed: scanResult.checks.filter(c => c.status === 'fail').length,
      review: scanResult.checks.filter(c => c.status === 'review').length,
      unavailable: scanResult.checks.filter(c => c.status === 'unavailable').length,
    }),
    [scanResult.checks]
  );

  const blockingMissing = useMemo(
    () => BLOCKING_KEYS.filter(key => !data.fields[key]),
    [data.fields]
  );

  const lowConfidenceCount = data.unreadableRegions.length;

  const handleShare = async () => {
    const result = await onShare();
    setShareStatus(result);
    window.setTimeout(() => setShareStatus(null), 2500);
  };

  const downloadReport = () => {
    const blob = new Blob([buildReportText(scanResult)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `pharmatrace-report-${scanResult.id.slice(0, 8)}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveReport = () => {
    onSaveReport(scanResult);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  const commitManualEntry = () => {
    if (!manualKey || !manualValue.trim()) return;
    const edited = applyManualEntry(scanResult, manualKey, manualValue);
    setManualKey(null);
    setManualValue('');
    if (edited) {
      if (onApplyEdits) onApplyEdits(edited);
      else onSaveReport(edited);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 safe-area-inset-bottom">
      <header className="bg-white border-b border-gray-100 sticky top-0 z-40">
        <div className="max-w-md mx-auto px-4 py-3 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back">
            <ChevronRight size={24} className="rotate-180" />
          </Button>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={handleSaveReport} aria-label="Save report to history">
              <Download size={20} />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void handleShare()} aria-label="Share results">
              <Share2 size={20} />
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 py-4 pb-24">
        {saved && (
          <div className="mb-4 p-3 rounded-xl bg-primary-50 border border-primary-200 text-sm text-primary-700" role="status">
            Report saved to history.
          </div>
        )}
        {shareStatus && (
          <div className="mb-4 p-3 rounded-xl bg-primary-50 border border-primary-200 text-sm text-primary-700" role="status">
            {shareStatus === 'copied' ? 'Report copied to clipboard.' : 'Report shared.'}
          </div>
        )}

        {/* Skips lower confidence */}
        {scanResult.skippedFields.length > 0 && (
          <div className="mb-4 p-3 rounded-xl bg-warning-50 border border-warning-200 text-sm text-warning-800">
            Confidence is lower because {scanResult.skippedFields.length} detail
            {scanResult.skippedFields.length === 1 ? ' was' : 's were'} skipped.
          </div>
        )}

        {/* Not usable */}
        {!data.usable && (
          <Card variant="elevated" className="border-warning-300 mb-6">
            <div className="p-6 text-center">
              <AlertTriangle size={40} className="text-warning-500 mx-auto mb-3" aria-hidden="true" />
              <h2 className="text-xl font-semibold text-gray-900">Could not read enough text</h2>
              <p className="mt-2 text-sm text-gray-600">{data.rejectReason}</p>
              <p className="mt-1 text-xs text-gray-400">Nothing below was inferred — unread fields stay empty.</p>
            </div>
          </Card>
        )}

        {/* Verdict */}
        <Card variant="elevated" className={riskBorderColor}>
          <div className="p-6">
            <div className="flex items-center gap-4">
              <div className={`w-14 h-14 rounded-xl flex items-center justify-center flex-shrink-0 ${riskBgColor}`}>
                <RiskIcon size={28} className={riskTextColor} />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <Badge variant={RISK_BADGE_VARIANT[scanResult.riskLevel]} size="lg">
                    {riskLevelLabels[scanResult.riskLevel]}
                  </Badge>
                  <Badge variant="outline" size="sm">
                    {scanResult.analyzer === 'vision-model' ? 'Vision model' : 'On-device OCR'}
                  </Badge>
                </div>
                <p className="text-sm text-gray-600">{riskLevelDescriptions[scanResult.riskLevel]}</p>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-4 gap-2 text-center">
              <StatBox value={counts.passed} label="Pass" />
              <StatBox value={counts.failed} label="Fail" />
              <StatBox value={counts.review} label="Review" />
              <StatBox value={counts.unavailable} label="N/A" />
            </div>
            <p className="mt-3 text-xs text-gray-400">
              Evidence strength {scanResult.scanQuality}/100 · {formatDate(scanResult.timestamp)}
            </p>
          </div>
        </Card>

        {/* Identification fallback chain */}
        {scanResult.identification && (
          <Card variant="outlined" padding="md" className="mt-6">
            <h3 className="font-semibold text-gray-900 mb-2">Identification</h3>
            <p className="text-sm text-gray-700">
              Identified via: <span className="font-medium">{IDENTIFICATION_LABELS[scanResult.identification.method]}</span>,
              confidence: <span className="font-medium">{scanResult.identification.confidence}</span>
            </p>
            {scanResult.identification.productName && (
              <p className="text-sm text-gray-900 mt-1 font-medium">{scanResult.identification.productName}</p>
            )}
            <p className="text-xs text-gray-500 mt-1">{scanResult.identification.detail}</p>
          </Card>
        )}

        {/* Drug class from composition (never from batch) */}
        {scanResult.drugClass && (
          <div className="mt-6 p-3 rounded-xl bg-secondary-50 border border-secondary-200 text-sm text-secondary-800" role="note">
            Composition suggests: {scanResult.drugClass.classes.join(', ')}. General information only, follow your
            doctor's prescription.
          </div>
        )}

        {/* Medicine information from product dataset */}
        {scanResult.productInfo && (
          <MedicineInfoCard info={scanResult.productInfo} />
        )}

        {/* Batch information panel */}
        {scanResult.batchInfo && (
          <Card variant="outlined" padding="md" className="mt-6">
            <h3 className="font-semibold text-gray-900 mb-2">Batch information</h3>
            {scanResult.batchInfo.reference ? (
              <div className="text-sm text-gray-700 space-y-1">
                <p>
                  Recorded: <span className="font-medium">{scanResult.batchInfo.reference.product}</span> by{' '}
                  <span className="font-medium">{scanResult.batchInfo.reference.manufacturer}</span>
                </p>
                {scanResult.batchInfo.reference.mfg && <p>Mfg: {scanResult.batchInfo.reference.mfg}</p>}
                {scanResult.batchInfo.reference.exp && <p>Exp: {scanResult.batchInfo.reference.exp}</p>}
                {scanResult.batchInfo.reference.source && (
                  <p className="text-xs text-gray-500">Source: {scanResult.batchInfo.reference.source}</p>
                )}
                {scanResult.batchInfo.reference.status && (
                  <p className="text-xs text-gray-500">Status: {scanResult.batchInfo.reference.status}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-700">
                Batch {scanResult.batchInfo.batch} not in reference data. Cannot be verified.
              </p>
            )}
            {scanResult.batchInfo.formatCheck && (
              <p className="mt-2 text-xs text-gray-500">{scanResult.batchInfo.formatCheck.detail}</p>
            )}
            <p className="mt-2 text-xs text-gray-400">A batch number says nothing about the medicine type or its content.</p>
          </Card>
        )}

        {/* Traced text overlay (green/amber/red by confidence) */}
        {data.rawTextLines.length > 0 && (
          <Card variant="outlined" padding="md" className="mt-6">
            <button className="w-full flex items-center justify-between" onClick={() => setShowBoxes(prev => !prev)} aria-expanded={showBoxes}>
              <h3 className="font-semibold text-gray-900">Traced text ({data.rawTextLines.length} lines)</h3>
              {showBoxes ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
            </button>
            {showBoxes && (
              <div className="mt-3">
                <div className="relative rounded-xl overflow-hidden bg-gray-900">
                  <img src={scanResult.imageUrl} alt="Scanned package with traced text" className="w-full object-contain" />
                  {data.rawTextLines.map((line, index) => (
                    <button
                      key={index}
                      onClick={() => setSelectedLine(line)}
                      className={`absolute rounded-sm border ${BOX_CLASSES[line.confidence]}`}
                      style={boxStyle(line.bbox, scanResult.imageWidth, scanResult.imageHeight)}
                      aria-label={`Read text: ${line.text.trim() || '(unreadable)'}`}
                    />
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-primary-500" /> high</span>
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-warning-400" /> medium</span>
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-danger-400" /> low</span>
                  <span className="ml-auto">Tap a box to see the text and the field it fed</span>
                </div>
              </div>
            )}
          </Card>
        )}

        {/* Decoded codes (QR / DataMatrix / 1D) — payloads shown raw, never auto-opened */}
        {data.codes.length > 0 && (
          <Card variant="outlined" padding="md" className="mt-6">
            <h3 className="font-semibold text-gray-900 mb-1 flex items-center gap-2">
              <QrCode size={18} aria-hidden="true" />
              Decoded code{data.codes.length === 1 ? '' : 's'} ({data.codes.length})
            </h3>
            <p className="text-xs text-gray-500 mb-3">
              A readable code does not prove authenticity — codes can be copied onto fake packs.
            </p>
            <div className="space-y-2">
              {data.codes.map((code, index) => (
                <CodeRow
                  key={`${code.format}-${index}`}
                  code={code}
                  open={openCode === index}
                  onToggle={() => setOpenCode(openCode === index ? null : index)}
                  onOpenUrl={() => setWarnedUrl(code.payload)}
                />
              ))}
            </div>
          </Card>
        )}

        {/* Extracted fields */}
        <Card variant="outlined" padding="md" className="mt-6">
          <h3 className="font-semibold text-gray-900 mb-4">Extracted Information</h3>
          <div className="space-y-1">
            {FIELD_LABELS.map(({ key, label, mono }) => {
              const field = data.fields[key];
              return (
                <div key={key} className="py-2 border-b border-gray-100 last:border-0">
                  <div className="flex items-start justify-between gap-4">
                    <span className="text-gray-500 text-sm">{label}</span>
                    {field ? (
                      <span className={`font-medium text-gray-900 text-right ${mono ? 'font-mono text-sm' : ''}`}>
                        {field.value}
                        <span
                          className={`ml-2 inline-block w-2 h-2 rounded-full align-middle ${
                            field.confidence === 'high'
                              ? 'bg-primary-500'
                              : field.confidence === 'medium'
                                ? 'bg-warning-400'
                                : 'bg-danger-400'
                          }`}
                          title={field.origin === 'user' ? 'entered by user' : `${field.confidence} confidence`}
                        />
                      </span>
                    ) : (
                      <span className="text-gray-300 text-sm italic">Not found</span>
                    )}
                  </div>
                  {field?.provenance?.matchedText && (
                    <p className="mt-1 text-xs text-gray-400 text-right font-mono truncate">
                      from: "{field.provenance.matchedText}"
                      {field.origin === 'user' && ' · entered by user'}
                    </p>
                  )}
                  {/* Smart guidance + actions for missing edge-printed fields */}
                  {!field && EDGE_PRINTED_KEYS.includes(key) && data.usable && (
                    <div className="mt-1.5 flex flex-col items-end gap-1.5">
                      <p className="text-xs text-gray-500 text-right max-w-[280px]">{NOT_VISIBLE_MESSAGE}</p>
                      <div className="flex gap-2">
                        {onCropRescan && scanResult.photos.length > 0 && (
                          <Button variant="ghost" size="sm" onClick={() => setCropTarget({ photo: scanResult.photos[scanResult.photos.length - 1] })}>
                            <Crop size={14} />
                            Rescan a cropped region
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setManualKey(key);
                            setManualValue('');
                          }}
                        >
                          <Keyboard size={14} />
                          Type it
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        {/* Checks */}
        <Card variant="outlined" padding="md" className="mt-6">
          <h3 className="font-semibold text-gray-900 mb-4">Verification Checks ({scanResult.checks.length})</h3>
          <div className="space-y-3">
            {scanResult.checks.map(check => (
              <CheckRow key={check.id} check={check} />
            ))}
          </div>
          {blockingMissing.length > 0 && (
            <p className="mt-4 text-xs text-warning-700 bg-warning-50 border border-warning-200 rounded-xl p-3">
              No final verdict strength is claimed — {blockingMissing.map(labelFor).join(', ')} still missing.
            </p>
          )}
        </Card>

        {/* Data collected */}
        <Card variant="outlined" padding="md" className="mt-6">
          <h3 className="font-semibold text-gray-900 mb-3">Data collected</h3>
          <div className="space-y-2 text-sm">
            <p className="text-gray-600">
              <span className="font-medium text-gray-900">{scanResult.photos.length}</span> photo
              {scanResult.photos.length === 1 ? '' : 's'} analyzed:
            </p>
            <ul className="ml-4 list-disc space-y-1">
              {scanResult.photos.map(photo => (
                <li key={photo.id} className="text-gray-600">
                  {photo.label} <span className="text-gray-400 text-xs">({new Date(photo.addedAt).toLocaleTimeString()})</span>
                </li>
              ))}
            </ul>
            {scanResult.userEnteredFields.length > 0 && (
              <p className="text-gray-600">
                Typed by user: <span className="font-medium">{scanResult.userEnteredFields.map(labelFor).join(', ')}</span>
              </p>
            )}
            {scanResult.skippedFields.length > 0 && (
              <p className="text-gray-600">
                Still missing: <span className="font-medium">{scanResult.skippedFields.map(labelFor).join(', ')}</span>
              </p>
            )}
          </div>
        </Card>

        {/* Unreadable regions: single summary + debug list */}
        {lowConfidenceCount > 0 && (
          <Card variant="outlined" padding="md" className="mt-6 border-warning-200 bg-warning-50">
            <button className="w-full flex items-center justify-between" onClick={() => setShowRawList(prev => !prev)} aria-expanded={showRawList}>
              <span className="text-sm text-warning-800">
                {lowConfidenceCount} low-confidence region{lowConfidenceCount === 1 ? '' : 's'} ignored
              </span>
              {showRawList ? <ChevronDown size={16} className="text-warning-700" /> : <ChevronRight size={16} className="text-warning-700" />}
            </button>
            {showRawList && (
              <ul className="mt-3 space-y-1 max-h-48 overflow-y-auto">
                {data.unreadableRegions.map((region, index) => (
                  <li key={index} className="font-mono text-xs text-warning-700 truncate">
                    [{Math.round(region.confidence)}] "{region.text}"
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {/* All read text */}
        {data.rawTextLines.length > 0 && (
          <Card variant="outlined" padding="md" className="mt-6">
            <h3 className="font-semibold text-gray-900 mb-3">All text read from the image</h3>
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {data.rawTextLines.map((line, index) => (
                <p key={index} className="font-mono text-xs text-gray-600">
                  <span
                    className={`inline-block w-2 h-2 rounded-full mr-2 align-middle ${
                      line.confidence === 'high' ? 'bg-primary-500' : line.confidence === 'medium' ? 'bg-warning-400' : 'bg-danger-400'
                    }`}
                  />
                  {line.text.trim() || '(empty)'}
                  {(line.orientation ?? 0) !== 0 && <span className="ml-2 text-gray-400">({line.orientation === 1 ? '90°' : '270°'})</span>}
                </p>
              ))}
            </div>
          </Card>
        )}

        {/* Debug + actions */}
        <Card variant="outlined" padding="md" className="mt-6">
          <Button variant="ghost" fullWidth onClick={() => setShowDebug(true)} className="justify-start">
            <Info size={18} />
            Show raw analyzer output (debug)
          </Button>
        </Card>

        <div className="mt-6 flex flex-col sm:flex-row gap-3">
          <Button variant="primary" fullWidth size="lg" onClick={onRescan} leftIcon={<RefreshCw size={20} />}>
            Scan Again
          </Button>
          <Button variant="secondary" fullWidth size="lg" onClick={downloadReport} leftIcon={<Download size={20} />}>
            Save Report
          </Button>
        </div>

        <p className="mt-6 text-xs text-gray-400 text-center">
          Screening aid only — this does not verify chemical content. Consult a pharmacist.
        </p>
      </main>

      {/* Crop-rescan modal: drag-free simple region picker */}
      <Modal isOpen={!!cropTarget} onClose={() => { setCropTarget(null); setCropRect(null); }} title="Rescan a cropped region" size="lg">
        {cropTarget && (
          <>
            <p className="text-sm text-gray-600 mb-3">
              Enter the region to re-read as percentages of the image (0-100). Tip: the sideways batch strip is usually
              one narrow horizontal or vertical band.
            </p>
            <CropPicker imageUrl={cropTarget.photo.dataUrl} onChange={setCropRect} />
            <div className="mt-4 flex justify-end gap-3">
              <Button variant="ghost" onClick={() => { setCropTarget(null); setCropRect(null); }}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!cropRect}
                onClick={() => {
                  if (cropRect && onCropRescan) {
                    onCropRescan(cropTarget.photo.id, cropRect);
                  }
                  setCropTarget(null);
                  setCropRect(null);
                }}
              >
                <Crop size={16} />
                Re-read region
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* Manual entry modal */}
      <Modal isOpen={!!manualKey} onClose={() => setManualKey(null)} title={`Enter ${manualKey ? labelFor(manualKey) : 'value'}`} size="sm">
        <Input
          label={manualKey ? labelFor(manualKey) : ''}
          value={manualValue}
          onChange={e => setManualValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') commitManualEntry();
          }}
        />
        <p className="mt-2 text-xs text-gray-400">Marked "entered by user" and counted as lower-confidence evidence.</p>
        <div className="mt-4 flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setManualKey(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={commitManualEntry}
            disabled={!manualValue.trim()}
          >
            Save
          </Button>
        </div>
      </Modal>

      {/* Tapped text-box detail: what was read there and which field it fed */}
      <Modal isOpen={!!selectedLine} onClose={() => setSelectedLine(null)} title="Traced text" size="sm">
        {selectedLine && (
          <>
            <p className="font-mono text-sm text-gray-900 bg-gray-50 rounded-xl p-3">
              {selectedLine.text.trim() || '(unreadable)'}
            </p>
            <div className="mt-3 space-y-1 text-sm">
              <p className="text-gray-500">
                Confidence:{' '}
                <span
                  className={`font-medium ${
                    selectedLine.confidence === 'high'
                      ? 'text-primary-700'
                      : selectedLine.confidence === 'medium'
                        ? 'text-warning-700'
                        : 'text-danger-700'
                  }`}
                >
                  {selectedLine.confidence}
                  {selectedLine.wordConfidence !== undefined && ` (${Math.round(selectedLine.wordConfidence)})`}
                </span>
              </p>
              {(selectedLine.orientation ?? 0) !== 0 && (
                <p className="text-gray-500">Read on the {selectedLine.orientation === 1 ? '90°' : '270°'} rotated pass.</p>
              )}
              {selectedLine.fields && selectedLine.fields.length > 0 ? (
                <p className="text-gray-700">
                  Fed: <span className="font-medium">{selectedLine.fields.map(key => labelFor(key as FieldKey)).join(', ')}</span>
                </p>
              ) : (
                <p className="text-gray-500">This line did not feed any extracted field.</p>
              )}
            </div>
          </>
        )}
      </Modal>

      {/* URL warning: decoded payloads are untrusted — never auto-opened */}
      <Modal isOpen={!!warnedUrl} onClose={() => setWarnedUrl(null)} title="Open this link?" size="sm">
        {warnedUrl && (
          <>
            <p className="text-sm text-gray-600">
              This code links to <span className="font-medium text-gray-900">{safeDomain(warnedUrl)}</span>. A copied or
              fake code can point anywhere — opening it is at your own risk.
            </p>
            <p className="mt-2 text-xs text-gray-500 break-all">{warnedUrl}</p>
            <div className="mt-4 flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setWarnedUrl(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  window.open(warnedUrl, '_blank', 'noopener,noreferrer');
                  setWarnedUrl(null);
                }}
              >
                Open link
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* Debug modal */}
      <Modal isOpen={showDebug} onClose={() => setShowDebug(false)} title="Raw analyzer output" size="lg">
        <pre className="p-3 rounded-xl bg-gray-950 text-xs text-primary-200 overflow-auto max-h-[60vh] whitespace-pre-wrap">
          {JSON.stringify(debugPayload(scanResult), null, 2)}
        </pre>
      </Modal>
    </div>
  );
}

function labelFor(key: FieldKey): string {
  return FIELD_LABELS.find(entry => entry.key === key)?.label ?? key;
}

const BOX_CLASSES: Record<TextLine['confidence'], string> = {
  high: 'border-primary-400 bg-primary-400/15',
  medium: 'border-warning-400 bg-warning-400/15',
  low: 'border-danger-400 bg-danger-400/15',
};

/** Percent-based absolute positioning over the result image. */
function boxStyle(bbox: BBox, imageWidth: number, imageHeight: number): React.CSSProperties {
  if (imageWidth <= 0 || imageHeight <= 0) return { display: 'none' };
  return {
    left: `${(bbox.x0 / imageWidth) * 100}%`,
    top: `${(bbox.y0 / imageHeight) * 100}%`,
    width: `${((bbox.x1 - bbox.x0) / imageWidth) * 100}%`,
    height: `${((bbox.y1 - bbox.y0) / imageHeight) * 100}%`,
  };
}

function StatBox({ value, label }: { value: number; label: string }) {
  return (
    <div className="p-2 rounded-xl bg-gray-50">
      <p className="text-xl font-bold text-gray-900">{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  );
}

function CheckRow({ check }: { check: CheckResult }) {
  const Icon = CHECK_ICON[check.status];
  const badge = CHECK_BADGE[check.status];
  return (
    <div className="p-3 rounded-xl border border-gray-200">
      <div className="flex items-start gap-3">
        <Icon size={18} className={`mt-0.5 flex-shrink-0 ${CHECK_COLOR[check.status]}`} aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-medium text-gray-900 text-sm">{check.name}</h4>
            <Badge variant={badge.variant} size="sm">{badge.label}</Badge>
          </div>
          <p className="text-sm text-gray-600 mt-0.5">{check.reason}</p>
        </div>
      </div>
    </div>
  );
}

/** Percentage-based region picker (no drag dependency; works with number fields + preview). */
function CropPicker({ imageUrl, onChange }: { imageUrl: string; onChange: (bbox: BBox | null) => void }) {
  const [x, setX] = useState(0);
  const [y, setY] = useState(60);
  const [w, setW] = useState(100);
  const [h, setH] = useState(25);

  const clamp = (value: number) => Math.max(0, Math.min(100, value));

  const commit = (nx: number, ny: number, nw: number, nh: number) => {
    const x0 = clamp(nx);
    const y0 = clamp(ny);
    const x1 = clamp(nx + nw);
    const y1 = clamp(ny + nh);
    if (x1 - x0 < 2 || y1 - y0 < 2) {
      onChange(null);
      return;
    }
    onChange({ x0, y0, x1, y1 });
  };

  return (
    <div>
      <div className="relative rounded-xl overflow-hidden bg-gray-900 mb-3">
        <img src={imageUrl} alt="Crop target" className="w-full object-contain" />
        <div
          className="absolute border-2 border-primary-400 bg-primary-400/20"
          style={{ left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` }}
        />
      </div>
      <div className="grid grid-cols-4 gap-2">
        <NumberField label="X %" value={x} onChange={v => { setX(v); commit(v, y, w, h); }} />
        <NumberField label="Y %" value={y} onChange={v => { setY(v); commit(x, v, w, h); }} />
        <NumberField label="W %" value={w} onChange={v => { setW(v); commit(x, y, v, h); }} />
        <NumberField label="H %" value={h} onChange={v => { setH(v); commit(x, y, w, v); }} />
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="text-xs text-gray-500">{label}</span>
      <input
        type="number"
        min={0}
        max={100}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(invalid URL)';
  }
}

/** One decoded code: format + raw payload, expandable for parsed details. */
function CodeRow({
  code,
  open,
  onToggle,
  onOpenUrl,
}: {
  code: DecodedCode;
  open: boolean;
  onToggle: () => void;
  onOpenUrl: () => void;
}) {
  const parsed = parseCodePayload(code.payload);
  return (
    <div className="rounded-xl border border-gray-200 p-3">
      <button className="w-full text-left" onClick={onToggle} aria-expanded={open}>
        <div className="flex items-center gap-2">
          <Badge variant="outline" size="sm">{code.format}</Badge>
          <span className="font-mono text-xs text-gray-700 truncate flex-1">{code.payload}</span>
          {open ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
        </div>
      </button>
      {open && (
        <div className="mt-2 text-sm">
          {parsed.kind === 'gs1' && parsed.elements.length > 0 && (
            <ul className="space-y-1">
              {parsed.elements.map(el => (
                <li key={el.ai} className="text-gray-700">
                  <span className="text-gray-400 font-mono text-xs mr-2">({el.ai})</span>
                  {el.label}: <span className="font-medium">{el.value}</span>
                </li>
              ))}
            </ul>
          )}
          {parsed.kind === 'url' && (
            <div>
              <p className="text-gray-700">
                Links to: <span className="font-medium">{parsed.domain || '(unknown domain)'}</span>
              </p>
              <Button variant="secondary" size="sm" className="mt-2" onClick={onOpenUrl}>
                Open link (see warning)
              </Button>
            </div>
          )}
          {parsed.kind === 'plain' && <p className="text-gray-500 text-xs">Plain text payload — no GS1 or URL structure detected.</p>}
          <p className="mt-2 text-xs text-gray-400">Decoded by {code.source === 'native-detector' ? 'the browser' : 'on-device zxing'}.</p>
        </div>
      )}
    </div>
  );
}

function debugPayload(scan: ScanResult) {
  const data = scan.extractedData;
  return {
    analyzer: scan.analyzer,
    usable: data.usable,
    keywordHits: data.keywordHits,
    blurScore: Number(data.blurScore.toFixed(4)),
    fields: Object.fromEntries(
      Object.entries(data.fields).map(([key, value]) => [
        key,
        value
          ? {
              value: value.value,
              confidence: value.confidence,
              origin: value.origin,
              matchedText: value.provenance?.matchedText,
              run: value.provenance?.runLabel,
              bbox: value.provenance?.bbox,
            }
          : null,
      ])
    ),
    textLines: data.rawTextLines.map(line => ({
      text: line.text,
      confidence: line.confidence,
      wordConfidence: line.wordConfidence,
      run: line.runLabel,
      bbox: line.bbox,
    })),
    codes: data.codes.map(code => ({ format: code.format, payload: code.payload, source: code.source })),
    checks: scan.checks,
    photos: scan.photos.map(p => p.label),
    identification: scan.identification,
    drugClass: scan.drugClass,
    batchInfo: scan.batchInfo,
  };
}

export type { TextLine };


function MedicineInfoCard({ info }: { info: ProductInfo }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Card variant="elevated" padding="md" className="mt-6 border-primary-200">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-bold text-gray-900 text-base">{info.brand}</h3>
            <Badge variant="info" size="sm">{info.drugClass}</Badge>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">{info.dosageForm}</p>
          <p className="text-xs text-gray-500">{info.manufacturerDisplay}</p>
          {info.licenseNo && (
            <p className="text-xs text-gray-400 mt-0.5 font-mono">Lic: {info.licenseNo}</p>
          )}
        </div>
        <button
          className="text-xs text-primary-600 font-medium shrink-0 mt-1"
          onClick={() => setExpanded(prev => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      </div>

      {/* Ingredients — always shown */}
      <div className="mt-3 pt-3 border-t border-gray-100">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Ingredients</p>
        <ul className="space-y-0.5">
          {info.ingredients.map(ing => (
            <li key={ing.name} className="text-sm text-gray-800">
              {ing.name}{' '}
              <span className="text-gray-500 font-mono text-xs">{ing.strengthMg} mg</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Uses — always shown */}
      <div className="mt-3 pt-3 border-t border-gray-100">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Uses</p>
        <p className="text-sm text-gray-800">{info.uses}</p>
      </div>

      {/* Side effects + warnings — shown only when expanded */}
      {expanded && (
        <>
          <div className="mt-3 pt-3 border-t border-gray-100">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Common side effects</p>
            <ul className="space-y-1">
              {info.sideEffects.map((effect, i) => (
                <li key={i} className="text-sm text-gray-800 flex items-start gap-2">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-warning-400 shrink-0" aria-hidden="true" />
                  {effect}
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-3 pt-3 border-t border-gray-100">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Warnings</p>
            <ul className="space-y-1">
              {info.warnings.map((warning, i) => (
                <li key={i} className="text-sm text-gray-800 flex items-start gap-2">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-danger-400 shrink-0" aria-hidden="true" />
                  {warning}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <p className="mt-3 text-xs text-gray-400">
        General information only. Always follow your doctor's or pharmacist's instructions.
      </p>
    </Card>
  );
}
