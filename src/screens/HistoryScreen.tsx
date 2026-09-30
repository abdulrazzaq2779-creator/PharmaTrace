import { useMemo, useState } from 'react';
import { AlertTriangle, Calendar, Filter, Search, Shield, Trash2 } from 'lucide-react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { Input } from '../components/Input';
import { Modal } from '../components/Modal';
import { Icon } from '../components/Icons';
import type { RiskLevel, ScanResult } from '../types';
import { riskLevelLabels } from '../data/mockData';
import { formatRelativeTime, getRiskLevelIcon } from '../utils/helpers';
import { summarizeChecks } from '../services/storage';

interface HistoryScreenProps {
  scanResults: ScanResult[];
  historyError: string | null;
  onClearHistory: () => void;
  onSelectScan: (scan: ScanResult) => void;
  onDeleteScan: (id: string) => void;
}

const RISK_FILTERS: Array<{ value: RiskLevel | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'consistent', label: 'Consistent' },
  { value: 'needs-review', label: 'Needs Review' },
  { value: 'high-risk', label: 'High Risk' },
];

const RISK_BADGE_VARIANT: Record<RiskLevel, 'success' | 'warning' | 'danger'> = {
  consistent: 'success',
  'needs-review': 'warning',
  'high-risk': 'danger',
};

export function HistoryScreen({
  scanResults,
  historyError,
  onClearHistory,
  onSelectScan,
  onDeleteScan,
}: HistoryScreenProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterRisk, setFilterRisk] = useState<RiskLevel | 'all'>('all');
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ScanResult | null>(null);

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return scanResults.filter(scan => {
      const product = `${scan.extractedData.medicineName ?? ''} ${scan.extractedData.strength ?? ''}`.trim().toLowerCase();
      const matchesQuery =
        query === '' ||
        product.includes(query) ||
        (scan.extractedData.manufacturer ?? '').toLowerCase().includes(query) ||
        (scan.extractedData.batchNumber ?? '').toLowerCase().includes(query);
      const matchesRisk = filterRisk === 'all' || scan.riskLevel === filterRisk;
      return matchesQuery && matchesRisk;
    });
  }, [scanResults, searchQuery, filterRisk]);

  if (scanResults.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 safe-area-inset-bottom">
        <header className="bg-white border-b border-gray-100 sticky top-0 z-40">
          <div className="max-w-md mx-auto px-4 py-4">
            <h1 className="text-xl font-semibold text-gray-900">Scan History</h1>
          </div>
        </header>
        <main className="max-w-md mx-auto px-4 pt-24 pb-24 flex flex-col items-center">
          <div className="w-20 h-20 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
            <Shield size={32} className="text-gray-400" aria-hidden="true" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">No Scans Yet</h2>
          <p className="text-gray-500 text-center max-w-xs">
            Your scan history will appear here. Start by scanning a medicine package.
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 safe-area-inset-bottom">
      <header className="bg-white border-b border-gray-100 sticky top-0 z-40">
        <div className="max-w-md mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-900">Scan History</h1>
          <Button variant="ghost" size="sm" onClick={() => setShowClearConfirm(true)} aria-label="Clear history">
            <Trash2 size={20} className="text-danger-600" />
          </Button>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 py-4 pb-24">
        {historyError && (
          <div className="mb-4 p-3 rounded-xl bg-warning-50 border border-warning-200 flex items-start gap-3" role="alert">
            <AlertTriangle size={18} className="text-warning-600 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <p className="text-sm text-warning-700">{historyError}</p>
          </div>
        )}

        <div className="space-y-4">
          <Input
            placeholder="Search by product, manufacturer, or batch..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            leftIcon={<Search size={18} />}
            aria-label="Search scan history"
          />

          <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Filter by risk level">
            <Filter size={16} className="text-gray-400 flex-shrink-0" aria-hidden="true" />
            {RISK_FILTERS.map(filter => (
              <button
                key={filter.value}
                onClick={() => setFilterRisk(filter.value)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  filterRisk === filter.value
                    ? 'bg-primary-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
                aria-pressed={filterRisk === filter.value}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <div className="space-y-3" role="list" aria-label="Scan history">
            {filtered.map(scan => {
              const productName = `${scan.extractedData.medicineName ?? 'Unknown'} ${scan.extractedData.strength ?? ''}`.trim();
              const counts = summarizeChecks(scan.checks);
              return (
                <Card
                  key={scan.id}
                  variant="outlined"
                  padding="none"
                  className="overflow-hidden hover:border-primary-200 transition-colors"
                  role="listitem"
                >
                  <div className="p-4 flex items-start gap-4">
                    <button
                      onClick={() => onSelectScan(scan)}
                      className="flex flex-1 items-start gap-4 text-left min-w-0"
                      aria-label={`Open details for ${productName}`}
                    >
                      <div className="w-16 h-16 rounded-xl bg-gray-100 flex-shrink-0 overflow-hidden relative flex items-center justify-center">
                        {scan.imageUrl.startsWith('demo://') ? (
                          <Icon name="pill" size={24} className="text-gray-400" />
                        ) : (
                          <img src={scan.imageUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                        )}
                        <div className="absolute inset-x-0 bottom-0 bg-black/40 py-0.5 flex items-center justify-center">
                          <Icon name={getRiskLevelIcon(scan.riskLevel)} size={12} className="text-white" />
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="font-medium text-gray-900 truncate">{productName}</h3>
                          <Badge variant={RISK_BADGE_VARIANT[scan.riskLevel]} size="sm" className="flex-shrink-0">
                            {riskLevelLabels[scan.riskLevel]}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 mt-2 text-sm text-gray-500">
                          <span className="flex items-center gap-1">
                            <Calendar size={12} aria-hidden="true" />
                            {formatRelativeTime(scan.timestamp)}
                          </span>
                          <span>
                            {counts.passed} passed · {counts.failed} failed · {counts.needsReview} review
                          </span>
                        </div>
                      </div>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPendingDelete(scan)}
                      className="flex-shrink-0"
                      aria-label={`Delete scan for ${productName}`}
                    >
                      <Trash2 size={16} className="text-danger-600" />
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>

          {filtered.length === 0 && (
            <div className="text-center py-12 text-gray-500">
              <Search size={32} className="mx-auto text-gray-300 mb-2" aria-hidden="true" />
              <p>No scans match your search or filter.</p>
            </div>
          )}
        </div>
      </main>

      <Modal
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        title="Clear History"
        description="This action cannot be undone"
        size="sm"
      >
        <p className="text-gray-600 mb-6">
          Delete all {scanResults.length} scan record{scanResults.length !== 1 ? 's' : ''} from your history?
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setShowClearConfirm(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              onClearHistory();
              setShowClearConfirm(false);
            }}
          >
            Clear All
          </Button>
        </div>
      </Modal>

      <Modal isOpen={!!pendingDelete} onClose={() => setPendingDelete(null)} title="Delete Scan" size="sm">
        {pendingDelete && (
          <>
            <p className="text-gray-600 mb-6">
              Delete the scan for{' '}
              <span className="font-medium text-gray-900">
                {pendingDelete.extractedData.medicineName ?? 'Unknown'} {pendingDelete.extractedData.strength ?? ''}
              </span>
              ?
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setPendingDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  onDeleteScan(pendingDelete.id);
                  setPendingDelete(null);
                }}
              >
                Delete
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
