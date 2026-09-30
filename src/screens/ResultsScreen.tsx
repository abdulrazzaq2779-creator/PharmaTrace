import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  HelpCircle,
  Info,
  MinusCircle,
  RefreshCw,
  Share2,
  XCircle,
} from 'lucide-react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { Modal } from '../components/Modal';
import type { CheckResult, RiskLevel, ScanResult, TextLine } from '../types';
import { FIELD_LABELS, riskLevelDescriptions, riskLevelLabels } from '../data/content';
import { formatDate, getRiskLevelColor } from '../utils/helpers';

interface ResultsScreenProps {
  scanResult: ScanResult;
  onBack: () => void;
  onRescan: () => void;
  onShare: () => Promise<'shared' | 'copied'>;
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

const CONFIDENCE_COLOR = {
  high: 'border-primary-500',
  medium: 'border-warning-400',
  low: 'border-danger-400',
} as const;

type FieldKey = Parameters<typeof fieldLabelFor>[0];

function fieldLabelFor(key: string): string {
  const found = FIELD_LABELS.find(entry => entry.key === key);
  return found?.label ?? key;
}

export function ResultsScreen({ scanResult, onRescan, onShare }: ResultsScreenProps) {
  const [shareStatus, setShareStatus] = useState<'shared' | 'copied' | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [showOverlay, setShowOverlay] = useState(false);
  const [selectedLine, setSelectedLine] = useState<TextLine | null>(null);
  const [checksExpanded, setChecksExpanded] = useState(true);

  const data = scanResult.extractedData;
  const RiskIcon = RISK_ICONS[scanResult.riskLevel];
  const riskColorClasses = getRiskLevelColor(scanResult.riskLevel);
  const [riskTextColor, riskBgColor, riskBorderColor] = riskColorClasses.split(' ');

  const counts = useMemo(() => {
    return {
      passed: scanResult.checks.filter(c => c.status === 'pass').length,
      failed: scanResult.checks.filter(c => c.status === 'fail').length,
      review: scanResult.checks.filter(c => c.status === 'review').length,
      unavailable: scanResult.checks.filter(c => c.status === 'unavailable').length,
    };
  }, [scanResult.checks]);

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

  return (
    <div className="min-h-screen bg-gray-50 safe-area-inset-bottom">
      <header className="bg-white border-b border-gray-100 sticky top-0 z-40">
        <div className="max-w-md mx-auto px-4 py-3 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={onRescan} aria-label="New scan">
            <ChevronRight size={24} className="rotate-180" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void handleShare()} aria-label="Share results">
            <Share2 size={20} />
          </Button>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 py-4 pb-24">
        {shareStatus && (
          <div className="mb-4 p-3 rounded-xl bg-primary-50 border border-primary-200 text-sm text-primary-700" role="status">
            {shareStatus === 'copied' ? 'Report copied to clipboard.' : 'Report shared.'}
          </div>
        )}

        {/* Rejected image */}
        {!data.usable && (
          <Card variant="elevated" className="border-warning-300 mb-6">
            <div className="p-6 text-center">
              <AlertTriangle size={40} className="text-warning-500 mx-auto mb-3" aria-hidden="true" />
              <h2 className="text-xl font-semibold text-gray-900">Not a medicine package</h2>
              <p className="mt-2 text-sm text-gray-600">{data.rejectReason ?? 'The image could not be identified as a medicine package.'}</p>
              <p className="mt-1 text-xs text-gray-400">All fields below were left unread on purpose — nothing was inferred.</p>
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
                  <Badge variant="outline" size="sm">{scanResult.analyzer === 'vision-model' ? 'Vision model' : 'On-device OCR'}</Badge>
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
              Image quality {scanResult.scanQuality}/100 · scanned {formatDate(scanResult.timestamp)}
            </p>
          </div>
        </Card>

        {/* Extracted fields — only real reads, otherwise "Not found" */}
        <Card variant="outlined" padding="md" className="mt-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-900">Extracted Information</h3>
            {data.rawTextLines.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setShowOverlay(true)} aria-label="Show text positions">
                <Eye size={18} />
              </Button>
            )}
          </div>
          <div className="space-y-1">
            {FIELD_LABELS.map(({ key, label, mono }) => {
              const field = data.fields[key];
              return (
                <div key={key} className="flex items-start justify-between gap-4 py-2 border-b border-gray-100 last:border-0">
                  <span className="text-gray-500 text-sm">{label}</span>
                  {field ? (
                    <span className={`font-medium text-gray-900 text-right ${mono ? 'font-mono text-sm' : ''}`}>
                      {field.value}
                      <span
                        className={`ml-2 inline-block w-2 h-2 rounded-full align-middle ${
                          field.confidence === 'high' ? 'bg-primary-500' : field.confidence === 'medium' ? 'bg-warning-400' : 'bg-danger-400'
                        }`}
                        title={`${field.confidence} confidence`}
                      />
                    </span>
                  ) : (
                    <span className="text-gray-300 text-sm italic">Not found</span>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        {/* Checks — EVERY check, with name, status, reason */}
        <Card variant="outlined" padding="md" className="mt-6">
          <button
            className="w-full flex items-center justify-between mb-2"
            onClick={() => setChecksExpanded(prev => !prev)}
            aria-expanded={checksExpanded}
          >
            <h3 className="font-semibold text-gray-900">Verification Checks ({scanResult.checks.length})</h3>
            {checksExpanded ? <ChevronDown size={18} className="text-gray-400" /> : <ChevronRight size={18} className="text-gray-400" />}
          </button>
          {checksExpanded && (
            <div className="space-y-3">
              {scanResult.checks.map(check => (
                <CheckRow key={check.id} check={check} />
              ))}
            </div>
          )}
        </Card>

        {/* Unreadable regions */}
        {data.unreadableRegions.length > 0 && (
          <Card variant="outlined" padding="md" className="mt-6 border-warning-200 bg-warning-50">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle size={18} className="text-warning-600" aria-hidden="true" />
              <h3 className="font-semibold text-gray-900">Unreadable / low-confidence regions</h3>
            </div>
            <ul className="space-y-2">
              {data.unreadableRegions.map((region, index) => (
                <li key={index} className="text-sm text-gray-700">
                  {region.reason}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {/* Raw text */}
        {data.rawTextLines.length > 0 && (
          <Card variant="outlined" padding="md" className="mt-6">
            <h3 className="font-semibold text-gray-900 mb-3">All text read from the image</h3>
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {data.rawTextLines.map((line, index) => (
                <p key={index} className="font-mono text-xs text-gray-600">
                  <span className={`inline-block w-2 h-2 rounded-full mr-2 align-middle ${line.confidence === 'high' ? 'bg-primary-500' : line.confidence === 'medium' ? 'bg-warning-400' : 'bg-danger-400'}`} />
                  {line.text.trim() || '(empty)'}
                  {line.orientation === 1 && <span className="ml-2 text-gray-400">(rotated)</span>}
                </p>
              ))}
            </div>
          </Card>
        )}

        {/* Debug panel */}
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
      </main>

      {/* Bounding-box overlay */}
      <Modal isOpen={showOverlay} onClose={() => setShowOverlay(false)} title="Where text was found" size="lg">
        <BoundingBoxOverlay
          imageUrl={scanResult.imageUrl}
          lines={data.rawTextLines}
          imageWidth={scanResult.imageWidth}
          imageHeight={scanResult.imageHeight}
          onSelect={line => {
            setSelectedLine(line);
          }}
        />
        {selectedLine && (
          <div className="mt-4 p-3 rounded-xl bg-gray-50 text-sm">
            <p className="font-mono text-gray-900">"{selectedLine.text.trim()}"</p>
            <p className="text-gray-500 mt-1">
              {selectedLine.fields && selectedLine.fields.length > 0
                ? `Fed fields: ${selectedLine.fields.map(fieldLabelFor).join(', ')}`
                : 'Did not feed any field'}
            </p>
            <p className="text-gray-400 text-xs mt-0.5">
              {selectedLine.confidence} confidence · {selectedLine.orientation === 1 ? 'rotated pass' : `band ${selectedLine.band}`}
            </p>
          </div>
        )}
      </Modal>

      {/* Debug modal */}
      <Modal isOpen={showDebug} onClose={() => setShowDebug(false)} title="Raw analyzer output" size="lg">
        <pre className="p-3 rounded-xl bg-gray-950 text-xs text-primary-200 overflow-auto max-h-[60vh] whitespace-pre-wrap">
          {JSON.stringify(
            {
              analyzer: scanResult.analyzer,
              usable: data.usable,
              rejectReason: data.rejectReason,
              blurScore: Number(data.blurScore.toFixed(4)),
              fields: Object.fromEntries(
                Object.entries(data.fields).map(([key, value]) => [key, value ? { value: value.value, confidence: value.confidence } : null])
              ),
              textLines: data.rawTextLines.map(line => ({
                text: line.text,
                confidence: line.confidence,
                band: line.band,
                orientation: line.orientation ?? 0,
                bbox: line.bbox,
              })),
              checks: scanResult.checks,
            },
            null,
            2
          )}
        </pre>
      </Modal>
    </div>
  );
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

/**
 * Bounding boxes over the image, colored by read confidence.
 * Coordinates are stored relative to the original decode (≤1600px), and the
 * thumbnail shown here is the same aspect, so percentages map 1:1.
 */
function BoundingBoxOverlay({
  imageUrl,
  lines,
  imageWidth,
  imageHeight,
  onSelect,
}: {
  imageUrl: string;
  lines: TextLine[];
  imageWidth: number;
  imageHeight: number;
  onSelect: (line: TextLine) => void;
}) {
  const withGeometry = lines.filter(line => line.bbox.x1 > line.bbox.x0 || line.bbox.y1 > line.bbox.y0);
  return (
    <div className="relative rounded-xl overflow-hidden bg-gray-900">
      <img src={imageUrl} alt="Scanned package" className="w-full object-contain" />
      {withGeometry.map((line, index) => {
        const left = (line.bbox.x0 / imageWidth) * 100;
        const top = (line.bbox.y0 / imageHeight) * 100;
        const width = ((line.bbox.x1 - line.bbox.x0) / imageWidth) * 100;
        const height = ((line.bbox.y1 - line.bbox.y0) / imageHeight) * 100;
        return (
          <button
            key={index}
            onClick={() => onSelect(line)}
            className={`absolute border-2 rounded-sm ${CONFIDENCE_COLOR[line.confidence]} bg-transparent hover:bg-white/10`}
            style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
            aria-label={line.text.trim() || 'unreadable text'}
          >
            <span className="sr-only">{line.text}</span>
          </button>
        );
      })}
    </div>
  );
}

function buildReportText(scan: ScanResult): string {
  const f = scan.extractedData.fields;
  const lines = [
    'PharmaTrace Scan Report',
    '=======================',
    `Brand: ${f.brand_name?.value ?? 'Not found'}`,
    `Composition: ${f.composition?.value ?? 'Not found'}`,
    `Manufacturer: ${f.manufacturer_name?.value ?? 'Not found'}`,
    `Batch: ${f.batch_no?.value ?? 'Not found'}`,
    `Expiry: ${f.expiry_date?.value ?? 'Not found'}`,
    `MRP: ${f.mrp?.value ?? 'Not found'}`,
    `Verdict: ${riskLevelLabels[scan.riskLevel]}`,
    '',
    'Checks:',
    ...scan.checks.map(c => `- [${c.status.toUpperCase()}] ${c.name}: ${c.reason}`),
    '',
    'Screening aid only — not a genuineness guarantee.',
  ];
  return lines.join('\n');
}
