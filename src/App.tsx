import { useCallback, useState } from 'react';
import { Camera, History, ScanLine, Settings } from 'lucide-react';
import { ScanScreen } from './screens/ScanScreen';
import { CollectScreen } from './screens/CollectScreen';
import { ResultsScreen } from './screens/ResultsScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useScanSession } from './hooks/useScanSession';
import { useAppSettings } from './hooks/useAppSettings';
import { useScanHistory } from './hooks/useScan';
import { buildReportText } from './utils/report';
import type { CaptureSource, FieldKey, ScanResult, Screen } from './types';

/** The key details the progress indicator counts. */
const KEY_DETAILS: FieldKey[] = [
  'brand_name',
  'composition',
  'manufacturer_name',
  'batch_no',
  'mfg_date',
  'expiry_date',
  'mrp',
];

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
  const [finalResult, setFinalResult] = useState<ScanResult | null>(null);
  const session = useScanSession();
  const { scanResults, historyError, upsertScan, deleteScan, clearHistory } = useScanHistory();
  const { settings, updateSetting, resetSettings } = useAppSettings();

  const analyzing = session.stage === 'analyzing';

  const handleScanComplete = useCallback(
    async (file: File, source: CaptureSource) => {
      // startScan returns the outcome; reading session.stage here would be stale.
      const outcome = await session.startScan(file, source);
      if (outcome) {
        if (outcome.stage === 'done' && outcome.final) {
          setFinalResult(outcome.final);
          upsertScan(outcome.final);
          setCurrentScreen('results');
        } else {
          setCurrentScreen('collect');
        }
      }
    },
    [session, upsertScan]
  );

  const handleCaptureStep = useCallback(
    (file: File, stepId: string) => {
      void session.addPhoto(file, stepId);
    },
    [session]
  );

  const handleFinish = useCallback(() => {
    const result = session.finish();
    if (result) {
      setFinalResult(result);
      // Every completed scan lands in history automatically (deduped on save).
      upsertScan(result);
      setCurrentScreen('results');
    }
  }, [session, upsertScan]);

  const handleSaveReport = useCallback(
    (scan: ScanResult) => {
      upsertScan(scan);
    },
    [upsertScan]
  );

  /** Manual entries / corrections applied on the results screen. */
  const handleApplyEdits = useCallback(
    (edited: ScanResult) => {
      setFinalResult(edited);
      upsertScan(edited);
    },
    [upsertScan]
  );

  const handleNewScan = useCallback(() => {
    session.reset();
    setFinalResult(null);
    setCurrentScreen('scan');
  }, [session]);

  const handleShare = useCallback((scan: ScanResult) => {
    const brand = scan.extractedData.fields.brand_name?.value ?? 'Unidentified pack';
    return shareOrCopy(buildReportText(scan), `PharmaTrace Scan: ${brand}`);
  }, []);

  const collectedDetails = KEY_DETAILS.filter(key => session.fields[key]).length;

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-gray-50">
        <main className="pb-20">
          {currentScreen === 'scan' && (
            <ScanScreen
              onScanComplete={handleScanComplete}
              isAnalyzing={analyzing}
              progress={session.progress}
              scanError={session.error}
              onDismissScanError={() => session.setError(null)}
            />
          )}
          {currentScreen === 'collect' && (
            <CollectScreen
              groups={session.pendingGroups}
              totalDetails={KEY_DETAILS.length}
              collectedDetails={collectedDetails}
              photos={session.photos}
              error={session.error}
              onCapture={handleCaptureStep}
              onEnterManually={session.enterManually}
              onSkip={session.skipStep}
              onFinish={handleFinish}
              canFinish={!analyzing}
            />
          )}
          {currentScreen === 'results' &&
            (finalResult ? (
              <ResultsScreen
                scanResult={finalResult}
                onBack={handleNewScan}
                onRescan={handleNewScan}
                onShare={() => handleShare(finalResult)}
                onSaveReport={handleSaveReport}
                onApplyEdits={handleApplyEdits}
                onCropRescan={(photoId, crop, stepId) => void session.rescanCrop(photoId, crop, stepId)}
              />
            ) : (
              <EmptyResults onGoToScan={handleNewScan} />
            ))}
          {currentScreen === 'history' && (
            <HistoryScreen
              scanResults={scanResults}
              historyError={historyError}
              onClearHistory={clearHistory}
              onSelectScan={scan => {
                setFinalResult(scan);
                setCurrentScreen('results');
              }}
              onDeleteScan={id => {
                deleteScan(id);
                setFinalResult(prev => (prev?.id === id ? null : prev));
              }}
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

export default App;
