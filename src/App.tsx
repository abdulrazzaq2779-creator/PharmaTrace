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
import type { CaptureSource, ScanResult, Screen } from './types';
import { fieldCountsAsCollected, KEY_DETAIL_KEYS } from './types';

/** The key details the progress indicator counts. */
// KEY_DETAIL_KEYS is imported from types — brand, composition, manufacturer,
// batch, MFG, EXP, MRP.  Using the canonical list avoids drift.

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
  const [navError, setNavError] = useState<string | null>(null);
  const session = useScanSession();
  const { scanResults, historyError, upsertScan, deleteScan, clearHistory } = useScanHistory();
  const { settings, updateSetting, resetSettings } = useAppSettings();

  const analyzing = session.stage === 'analyzing';

  const handleScanComplete = useCallback(
    async (file: File, source: CaptureSource) => {
      setNavError(null);
      try {
        console.log('[App] handleScanComplete — starting scan', file.name, source);
        const outcome = await session.startScan(file, source);
        console.log('[App] startScan resolved', outcome ? { stage: outcome.stage, hasFinal: !!outcome.final } : null);
        if (!outcome) {
          // startScan already set session.error; user sees scan-screen error.
          console.warn('[App] startScan returned null — session error set');
          return;
        }
        if (outcome.stage === 'done' && outcome.final) {
          try {
            setFinalResult(outcome.final);
            upsertScan(outcome.final);
            console.log('[App] navigating to results (done path)');
            setCurrentScreen('results');
          } catch (navErr) {
            console.error('[App] result navigation failed (done path)', navErr);
            setNavError('Analysis finished but the result could not be built. Tap "Show debug" for details.');
          }
        } else {
          console.log('[App] navigating to collect, pendingGroups', session.pendingGroups.length);
          setCurrentScreen('collect');
        }
      } catch (err) {
        console.error('[App] handleScanComplete threw unexpectedly', err);
        setNavError('Analysis finished but the result could not be built.');
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
    setNavError(null);
    try {
      console.log('[App] handleFinish — assembling result');
      const result = session.finish();
      if (result) {
        setFinalResult(result);
        upsertScan(result);
        console.log('[App] navigating to results (finish path)');
        setCurrentScreen('results');
      } else {
        console.error('[App] finish() returned null — no firstPass?');
        setNavError('Could not build the result. Please start a new scan.');
      }
    } catch (err) {
      console.error('[App] handleFinish threw', err);
      setNavError('Analysis finished but the result could not be built.');
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
    setNavError(null);
    setCurrentScreen('scan');
  }, [session]);

  const handleShare = useCallback((scan: ScanResult) => {
    const brand = scan.extractedData.fields.brand_name?.value ?? 'Unidentified pack';
    return shareOrCopy(buildReportText(scan), `PharmaTrace Scan: ${brand}`);
  }, []);

  // A key is "collected" if it has a confirmed/grounded field OR a pending candidate to confirm.
  const candidates = session.firstPass?.data.candidates ?? [];
  const candidateKeys = new Set(candidates.map(c => c.key));
  const collectedDetails = KEY_DETAIL_KEYS.filter(
    key => fieldCountsAsCollected(session.fields[key]) || candidateKeys.has(key)
  ).length;

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-gray-50">
        <main className="pb-20">
          {navError && (
            <div className="fixed inset-x-0 top-0 z-50 bg-danger-600 text-white text-sm px-4 py-3 flex items-center justify-between" role="alert">
              <span>{navError}</span>
              <button className="ml-4 underline" onClick={() => { console.log('[debug] session firstPass', session.firstPass); console.log('[debug] fields', session.fields); setNavError(null); }}>
                Show debug
              </button>
            </div>
          )}
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
              candidates={session.firstPass?.data.candidates ?? []}
              totalDetails={KEY_DETAIL_KEYS.length}
              collectedDetails={collectedDetails}
              photos={session.photos}
              error={session.error}
              onCapture={handleCaptureStep}
              onEnterManually={session.enterManually}
              onConfirmCandidate={session.confirmCandidate}
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
