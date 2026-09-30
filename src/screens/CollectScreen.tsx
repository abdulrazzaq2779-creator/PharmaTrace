import { useCallback, useRef, useState } from 'react';
import { Camera, Check, CheckCircle2, CircleAlert, Keyboard, SkipForward } from 'lucide-react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Badge } from '../components/Badge';
import { Input } from '../components/Input';
import type { MissingGroup } from '../hooks/useScanSession';
import type { FieldKey, SessionPhoto } from '../types';
import { FIELD_LABELS } from '../data/content';

interface CollectScreenProps {
  groups: MissingGroup[];
  /** How many key details exist (denominator of the progress bar). */
  totalDetails: number;
  /** How many key details are collected so far. */
  collectedDetails: number;
  photos: SessionPhoto[];
  error: string | null;
  onCapture: (file: File, stepId: string) => void;
  onEnterManually: (key: FieldKey, value: string) => void;
  onSkip: (stepId: string) => void;
  onFinish: () => void;
  canFinish: boolean;
}

function fieldLabel(key: FieldKey): string {
  return FIELD_LABELS.find(entry => entry.key === key)?.label ?? key;
}

export function CollectScreen({
  groups,
  totalDetails,
  collectedDetails,
  photos,
  error,
  onCapture,
  onEnterManually,
  onSkip,
  onFinish,
  canFinish,
}: CollectScreenProps) {
  const [activeStepId, setActiveStepId] = useState<string | null>(groups[0]?.stepId ?? null);
  const [showManual, setShowManual] = useState(false);
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeGroup = groups.find(g => g.stepId === activeStepId) ?? groups[0] ?? null;

  const handleCaptureClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file && activeGroup) onCapture(file, activeGroup.stepId);
      e.target.value = '';
    },
    [activeGroup, onCapture]
  );

  return (
    <div className="min-h-screen bg-gray-50 safe-area-inset-bottom">
      <header className="bg-white border-b border-gray-100 sticky top-0 z-40">
        <div className="max-w-md mx-auto px-4 py-4">
          <h1 className="text-xl font-semibold text-gray-900">Let's collect the rest</h1>
          <p className="text-sm text-gray-500 mt-1">
            {collectedDetails} of {totalDetails} details collected — missing data lowers confidence, it is never a failure.
          </p>
          <div className="mt-3 h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full bg-primary-500 transition-[width] duration-300"
              style={{ width: `${totalDetails === 0 ? 100 : (collectedDetails / totalDetails) * 100}%` }}
            />
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 py-4 pb-24">
        {error && (
          <div className="mb-4 p-3 rounded-xl bg-danger-50 border border-danger-200 text-sm text-danger-700" role="alert">
            {error}
          </div>
        )}

        {activeGroup ? (
          <Card variant="elevated" padding="md" className="animate-slide-up">
            <div className="flex items-center gap-2 mb-3">
              <CircleAlert size={18} className="text-warning-500" aria-hidden="true" />
              <h2 className="font-semibold text-gray-900">{activeGroup.title}</h2>
            </div>
            <p className="text-sm text-gray-600 mb-2">Still missing:</p>
            <div className="flex flex-wrap gap-2 mb-4">
              {activeGroup.missing.map(key => (
                <Badge key={key} variant="warning" size="sm">
                  {fieldLabel(key)}
                </Badge>
              ))}
            </div>
            <p className="text-sm text-gray-700 bg-gray-50 rounded-xl p-3 mb-4">{activeGroup.instruction}</p>

            <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={handleFile} className="hidden" aria-label={`Capture photo for ${activeGroup.title}`} />
            <div className="space-y-2">
              <Button variant="primary" fullWidth size="lg" onClick={handleCaptureClick}>
                <Camera size={20} />
                Photograph that area
              </Button>
              <Button variant="secondary" fullWidth onClick={() => setShowManual(prev => !prev)}>
                <Keyboard size={18} />
                {showManual ? 'Hide manual entry' : 'Type it manually instead'}
              </Button>
              <Button
                variant="ghost"
                fullWidth
                onClick={() => {
                  onSkip(activeGroup.stepId);
                  const remaining = groups.filter(g => g.stepId !== activeGroup.stepId);
                  setActiveStepId(remaining[0]?.stepId ?? null);
                }}
              >
                <SkipForward size={18} />
                Skip this step
              </Button>
            </div>

            {showManual && (
              <div className="mt-4 pt-4 border-t border-gray-100 space-y-3">
                {activeGroup.missing.map(key => (
                  <div key={key} className="flex items-end gap-2">
                    <Input
                      label={fieldLabel(key)}
                      value={manualValues[key] ?? ''}
                      onChange={e => setManualValues(prev => ({ ...prev, [key]: e.target.value }))}
                      placeholder={`Type ${fieldLabel(key).toLowerCase()}`}
                    />
                    <Button
                      variant="secondary"
                      onClick={() => {
                        const value = manualValues[key];
                        if (value?.trim()) {
                          onEnterManually(key, value);
                          setManualValues(prev => ({ ...prev, [key]: '' }));
                        }
                      }}
                    >
                      <Check size={18} />
                    </Button>
                  </div>
                ))}
                <p className="text-xs text-gray-400">
                  Values you type are marked "entered by user" and count as lower-confidence evidence.
                </p>
              </div>
            )}
          </Card>
        ) : (
          <Card variant="elevated" padding="md" className="text-center">
            <CheckCircle2 size={40} className="text-primary-500 mx-auto mb-3" aria-hidden="true" />
            <h2 className="font-semibold text-gray-900">All steps handled</h2>
            <p className="text-sm text-gray-500 mt-2">
              {groups.length === 0
                ? 'Every collected detail is in.'
                : 'You skipped the remaining steps — the result will note lower confidence.'}
            </p>
          </Card>
        )}

        {/* Photos collected this session */}
        {photos.length > 1 && (
          <Card variant="outlined" padding="md" className="mt-6">
            <h3 className="font-semibold text-gray-900 mb-3">Photos in this session</h3>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {photos.map(photo => (
                <div key={photo.id} className="flex-shrink-0 w-20">
                  <img src={photo.dataUrl} alt={photo.label} className="w-20 h-20 rounded-xl object-cover border border-gray-200" />
                  <p className="text-[10px] text-gray-500 mt-1 truncate">{photo.label}</p>
                </div>
              ))}
            </div>
          </Card>
        )}

        <Button variant="primary" fullWidth size="lg" className="mt-6" onClick={onFinish} disabled={!canFinish}>
          See the result
        </Button>
      </main>
    </div>
  );
}
