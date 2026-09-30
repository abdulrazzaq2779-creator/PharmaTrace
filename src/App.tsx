import { useCallback, useState } from 'react';
import { Camera, History, ScanLine, Settings } from 'lucide-react';
import { ScanScreen } from './screens/ScanScreen';
import { ResultsScreen } from './screens/ResultsScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useScanEngine, useScanHistory } from './hooks/useScan';
import { useAppSettings } from './hooks/useAppSettings';
import type { CaptureSource, ScanResult, Screen } from './types';

const TABS = [
  { id: 'scan', icon: Camera, label: 'Scan' },
  { id: 'history', icon: History, label: 'History' },
  { id: 'settings', icon: Settings, label: 'Settings' },
] as const;

function TabBar({
  currentScreen,
  onNavigate,
}: {
  currentScreen: Screen;
  onNavigate: (screen: Screen) => void;
}) {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 safe-area-inset-bottom z-50"
      role="navigation"
      aria-label="Main navigation"
    >
      <div className="max-w-md mx-auto flex items-center justify-around h-16">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => onNavigate(tab.id)}
            className={`flex flex-col items-center gap-1 px-4 py-2 transition-colors ${
              currentScreen === tab.id ? 'text-primary-600' : 'text-gray-500 hover:text-gray-700'
            }`}
            aria-current={currentScreen === tab.id ? 'page' : undefined}
            aria-label={tab.label}
          >
            <tab.icon size={24} aria-hidden="true" />
            <span className="text-xs font-medium">{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

async function shareOrCopy(report: string, title: string): Promise<'shared' | 'copied'> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, text: report });
      return 'shared';
    } catch {
      // User cancelled — fall through to clipboard.
    }
  }
  await navigator.clipboard.writeText(report);
  return 'copied';
}

function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('scan');
  const [currentScan, setCurrentScan] = useState<ScanResult | null>(null);
  const { stage, progress, error: scanError, clearError, performScan } = useScanEngine();
  const { scanResults, historyError, addScan, deleteScan, clearHistory } = useScanHistory();
  const { settings, updateSetting, resetSettings } = useAppSettings();

  const handleScanComplete = useCallback(
    async (file: File, source: CaptureSource) => {
      const result = await performScan(file, source);
      if (result) {
        setCurrentScan(result);
        addScan(result, settings.autoSave);
        setCurrentScreen('results');
      }
    },
    [performScan, addScan, settings.autoSave]
  );

  const handleSelectHistoryItem = useCallback((scan: ScanResult) => {
    setCurrentScan(scan);
    setCurrentScreen('results');
  }, []);

  const handleDeleteFromHistory = useCallback(
    (id: string) => {
      deleteScan(id);
      setCurrentScan(prev => (prev?.id === id ? null : prev));
    },
    [deleteScan]
  );

  const handleRescan = useCallback(() => {
    setCurrentScan(null);
    setCurrentScreen('scan');
  }, []);

  const handleShare = useCallback((scan: ScanResult) => {
    const brand = scan.extractedData.fields.brand_name?.value ?? 'Unidentified pack';
    return shareOrCopy(buildReportText(scan), `PharmaTrace Scan: ${brand}`);
  }, []);

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-gray-50">
        <main className="pb-20">
          {currentScreen === 'scan' && (
            <ScanScreen
              onScanComplete={handleScanComplete}
              stage={stage}
              progress={progress}
              scanError={scanError}
              onDismissScanError={clearError}
            />
          )}
          {currentScreen === 'results' &&
            (currentScan ? (
              <ResultsScreen
                scanResult={currentScan}
                onBack={handleRescan}
                onRescan={handleRescan}
                onShare={() => handleShare(currentScan)}
              />
            ) : (
              <EmptyResults onGoToScan={() => setCurrentScreen('scan')} />
            ))}
          {currentScreen === 'history' && (
            <HistoryScreen
              scanResults={scanResults}
              historyError={historyError}
              onClearHistory={clearHistory}
              onSelectScan={handleSelectHistoryItem}
              onDeleteScan={handleDeleteFromHistory}
            />
          )}
          {currentScreen === 'settings' && (
            <SettingsScreen
              settings={settings}
              onUpdateSetting={updateSetting}
              onResetSettings={resetSettings}
              scanCount={scanResults.length}
              onClearHistory={clearHistory}
            />
          )}
        </main>

        <TabBar currentScreen={currentScreen} onNavigate={setCurrentScreen} />
      </div>
    </ErrorBoundary>
  );
}

function EmptyResults({ onGoToScan }: { onGoToScan: () => void }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="text-center p-8">
        <ScanLine size={48} className="text-gray-300 mx-auto mb-4" aria-hidden="true" />
        <h2 className="text-xl font-semibold text-gray-900">No Results</h2>
        <p className="text-gray-500 mt-2">Scan a package to see results</p>
        <button onClick={onGoToScan} className="mt-4 text-primary-600 font-medium hover:underline">
          Go to Scan
        </button>
      </div>
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
    `Verdict: ${scan.riskLevel} (analyzer: ${scan.analyzer})`,
    '',
    'Checks:',
    ...scan.checks.map(c => `- [${c.status.toUpperCase()}] ${c.name}: ${c.reason}`),
    '',
    'Screening aid only — not a genuineness guarantee.',
  ];
  return lines.join('\n');
}

export default App;
