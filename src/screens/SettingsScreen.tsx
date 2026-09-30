import { useState } from 'react';
import {
  AlertTriangle,
  Download,
  ExternalLink,
  FileText,
  Info,
  Moon,
  RefreshCw,
  Shield,
  Sun,
  Trash2,
} from 'lucide-react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Modal } from '../components/Modal';
import { Icon } from '../components/Icons';
import type { AppSettings } from '../types';
import { APP_VERSION, buildSettingsExport, disclaimerText } from '../data/mockData';

interface SettingsScreenProps {
  settings: AppSettings;
  onUpdateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onResetSettings: () => void;
  scanCount: number;
  onClearHistory: () => void;
}

const LANGUAGES = [
  { code: 'en', nativeName: 'English' },
  { code: 'es', nativeName: 'Español' },
  { code: 'fr', nativeName: 'Français' },
  { code: 'de', nativeName: 'Deutsch' },
  { code: 'zh', nativeName: '中文' },
  { code: 'hi', nativeName: 'हिन्दी' },
  { code: 'ar', nativeName: 'العربية' },
  { code: 'pt', nativeName: 'Português' },
];

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="font-medium text-gray-900">{label}</p>
        <p className="text-sm text-gray-500">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-primary-600' : 'bg-gray-300'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}

function SectionHeader({ icon, title, iconClass }: { icon: React.ReactNode; title: string; iconClass: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${iconClass}`}>{icon}</div>
      <h2 className="font-semibold text-gray-900">{title}</h2>
    </div>
  );
}

export function SettingsScreen({
  settings,
  onUpdateSetting,
  onResetSettings,
  scanCount,
  onClearHistory,
}: SettingsScreenProps) {
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const exportData = () => {
    try {
      const json = buildSettingsExport(localStorage.getItem('pharmatrace-scan-results') ?? '[]', settings);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `pharmatrace-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setShowExportModal(false);
      setExportError(null);
    } catch {
      setExportError('Export failed — your browser blocked the download or storage is unavailable.');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 safe-area-inset-bottom">
      <header className="bg-white border-b border-gray-100 sticky top-0 z-40">
        <div className="max-w-md mx-auto px-4 py-4">
          <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 py-4 pb-24">
        <div className="space-y-6">
          <Card variant="outlined" padding="md">
            <SectionHeader
              icon={<Icon name="globe" size={20} className="text-primary-600" />}
              title="Language"
              iconClass="bg-primary-100"
            />
            <select
              value={settings.language}
              onChange={e => onUpdateSetting('language', e.target.value)}
              className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-primary-500"
              aria-label="Select language"
            >
              {LANGUAGES.map(lang => (
                <option key={lang.code} value={lang.code}>
                  {lang.nativeName}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-gray-400">
              New languages are planned — the interface is currently English-only.
            </p>
          </Card>

          <Card variant="outlined" padding="md">
            <SectionHeader
              icon={<Icon name="accessibility" size={20} className="text-secondary-600" />}
              title="Accessibility"
              iconClass="bg-secondary-100"
            />
            <div className="space-y-4">
              <ToggleRow
                label="Reduce Motion"
                description="Minimize animations and transitions"
                checked={settings.reducedMotion}
                onChange={value => onUpdateSetting('reducedMotion', value)}
              />
              <ToggleRow
                label="High Contrast"
                description="Increase color contrast for readability"
                checked={settings.highContrast}
                onChange={value => onUpdateSetting('highContrast', value)}
              />
              <ToggleRow
                label="Large Text"
                description="Increase text size throughout the app"
                checked={settings.largeText}
                onChange={value => onUpdateSetting('largeText', value)}
              />
            </div>
          </Card>

          <Card variant="outlined" padding="md">
            <SectionHeader
              icon={<Icon name="sun" size={20} className="text-warning-600" />}
              title="Appearance"
              iconClass="bg-warning-100"
            />
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { value: 'light', label: 'Light', icon: Sun },
                  { value: 'dark', label: 'Dark', icon: Moon },
                  { value: 'system', label: 'System', icon: RefreshCw },
                ] as const
              ).map(({ value, label, icon: ThemeIcon }) => (
                <button
                  key={value}
                  onClick={() => onUpdateSetting('theme', value)}
                  className={`relative rounded-xl border-2 p-4 text-center transition-all ${
                    settings.theme === value ? 'border-primary-500 bg-primary-50' : 'border-gray-200 hover:border-gray-300'
                  }`}
                  aria-pressed={settings.theme === value}
                >
                  <ThemeIcon
                    size={24}
                    className={`mx-auto mb-2 ${settings.theme === value ? 'text-primary-600' : 'text-gray-400'}`}
                    aria-hidden="true"
                  />
                  <p className={`font-medium ${settings.theme === value ? 'text-primary-700' : 'text-gray-700'}`}>{label}</p>
                  {settings.theme === value && (
                    <span className="absolute top-2 right-2 w-5 h-5 rounded-full bg-primary-500 flex items-center justify-center">
                      <Icon name="check" size={10} className="text-white" />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </Card>

          <Card variant="outlined" padding="md">
            <SectionHeader
              icon={<Icon name="database" size={20} className="text-secondary-600" />}
              title="Data & Privacy"
              iconClass="bg-secondary-100"
            />
            <div className="space-y-4">
              <ToggleRow
                label="Auto-save Scans"
                description="Automatically save scan results to history"
                checked={settings.autoSave}
                onChange={value => onUpdateSetting('autoSave', value)}
              />
              <ToggleRow
                label="Usage Analytics"
                description="Help improve the app with anonymous usage data"
                checked={settings.analytics}
                onChange={value => onUpdateSetting('analytics', value)}
              />
              <ToggleRow
                label="Notifications"
                description="Receive scan reminders and updates"
                checked={settings.notifications}
                onChange={value => onUpdateSetting('notifications', value)}
              />
            </div>
          </Card>

          <Card variant="outlined" padding="md">
            <SectionHeader
              icon={<Icon name="download" size={20} className="text-secondary-600" />}
              title="Data Management"
              iconClass="bg-secondary-100"
            />
            <div className="space-y-3">
              <Button variant="secondary" fullWidth leftIcon={<Download size={18} />} onClick={() => setShowExportModal(true)}>
                Export All Data
              </Button>
              <div className="pt-2 border-t border-gray-100">
                <Button
                  variant="ghost"
                  fullWidth
                  leftIcon={<Trash2 size={18} className="text-danger-600" />}
                  onClick={() => setShowClearConfirm(true)}
                  className="text-danger-600 hover:bg-danger-50 justify-start"
                >
                  Clear Scan History
                </Button>
                <p className="text-xs text-gray-500 mt-2 text-center">
                  {scanCount} scan{scanCount !== 1 ? 's' : ''} in history
                </p>
              </div>
            </div>
          </Card>

          <Card variant="outlined" padding="md">
            <SectionHeader
              icon={<Icon name="info" size={20} className="text-gray-600" />}
              title="About & Legal"
              iconClass="bg-gray-100"
            />
            <div className="space-y-1">
              <Button variant="ghost" fullWidth className="justify-start" leftIcon={<Info size={18} />} onClick={() => setShowAboutModal(true)}>
                About PharmaTrace
              </Button>
              <Button variant="ghost" fullWidth className="justify-start" leftIcon={<Shield size={18} />} onClick={() => setShowPrivacyModal(true)}>
                Privacy Policy
              </Button>
              <Button variant="ghost" fullWidth className="justify-start" leftIcon={<FileText size={18} />} onClick={() => setShowTermsModal(true)}>
                Terms of Service
              </Button>
              <Button
                variant="ghost"
                fullWidth
                className="justify-start"
                leftIcon={<ExternalLink size={18} />}
                onClick={() => window.open('https://github.com/topics/medicine-verification', '_blank', 'noopener')}
              >
                Open Source Licenses
              </Button>
            </div>
            <div className="pt-4 border-t border-gray-100 mt-3">
              <div className="flex items-center justify-between text-sm text-gray-500">
                <span>Version</span>
                <span className="font-mono">{APP_VERSION}</span>
              </div>
            </div>
          </Card>

          <Card variant="outlined" padding="md" className="border-danger-200 bg-danger-50">
            <div className="flex items-center gap-3">
              <AlertTriangle size={20} className="text-danger-600 flex-shrink-0" aria-hidden="true" />
              <div className="text-sm text-gray-700">
                <p className="font-medium text-danger-800">Reset All Settings</p>
                <p>This will restore default preferences and clear scan history. This action cannot be undone.</p>
              </div>
            </div>
            <Button variant="danger" fullWidth className="mt-4" onClick={() => setShowResetConfirm(true)}>
              Reset to Defaults
            </Button>
          </Card>
        </div>
      </main>

      <Modal
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        title="Clear Scan History"
        description="This action cannot be undone"
        size="sm"
      >
        <p className="text-gray-600 mb-6">
          Delete all {scanCount} scan record{scanCount !== 1 ? 's' : ''} from your history?
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

      <Modal
        isOpen={showResetConfirm}
        onClose={() => setShowResetConfirm(false)}
        title="Reset Settings"
        description="This action cannot be undone"
        size="sm"
      >
        <p className="text-gray-600 mb-6">
          Restore default settings and delete all scans? Your device is not otherwise affected.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setShowResetConfirm(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              onResetSettings();
              onClearHistory();
              setShowResetConfirm(false);
            }}
          >
            Reset Everything
          </Button>
        </div>
      </Modal>

      <Modal
        isOpen={showExportModal}
        onClose={() => setShowExportModal(false)}
        title="Export Data"
        description="Your data will be downloaded as a JSON file"
        size="sm"
      >
        {exportError && (
          <p className="mb-4 text-sm text-danger-600" role="alert">
            {exportError}
          </p>
        )}
        <p className="text-gray-600 mb-6">
          This exports your scan history and settings as a JSON file that you can save or transfer to another device.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setShowExportModal(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={exportData} leftIcon={<Download size={18} />}>
            Export
          </Button>
        </div>
      </Modal>

      <Modal isOpen={showAboutModal} onClose={() => setShowAboutModal(false)} title="About PharmaTrace" size="md">
        <div className="space-y-4 text-gray-600">
          <div className="text-center">
            <div className="w-16 h-16 rounded-2xl bg-primary-100 flex items-center justify-center mx-auto mb-4">
              <Shield size={32} className="text-primary-600" aria-hidden="true" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900">PharmaTrace</h3>
            <p className="text-sm text-gray-500 mt-1">Version {APP_VERSION}</p>
          </div>
          <p>
            PharmaTrace is a medicine authenticity screening tool that helps identify potentially counterfeit or
            problematic medication packages through visual analysis and data validation.
          </p>
          <p className="font-medium text-gray-900">Key Features</p>
          <ul className="list-disc list-inside space-y-1 ml-4">
            <li>Visual package comparison against reference templates</li>
            <li>Manufacturer-product validation</li>
            <li>Expiry date verification</li>
            <li>Batch number format checking</li>
            <li>OCR text extraction and validation</li>
          </ul>
          <div className="pt-4 border-t border-gray-100">
            <p className="text-sm text-gray-500 text-center">Built with React, TypeScript, and Tailwind CSS</p>
          </div>
        </div>
      </Modal>

      <Modal isOpen={showPrivacyModal} onClose={() => setShowPrivacyModal(false)} title="Privacy Policy" size="lg">
        <div className="space-y-4 text-sm text-gray-600 max-h-[60vh] overflow-y-auto">
          <p className="font-medium text-gray-900">Last updated: September 2026</p>
          <section>
            <h4 className="font-semibold text-gray-900">Data We Collect</h4>
            <p>
              PharmaTrace processes images locally on your device. Your medication photos are never uploaded to a
              server. Scan results are stored locally in your browser's storage.
            </p>
          </section>
          <section>
            <h4 className="font-semibold text-gray-900">Local Storage</h4>
            <p>
              Your scan history and preferences are stored using browser localStorage. This data never leaves your
              device unless you explicitly export it.
            </p>
          </section>
          <section>
            <h4 className="font-semibold text-gray-900">Camera Access</h4>
            <p>
              Camera access is requested only when you choose to take a photo. The video stream is processed locally
              and never transmitted.
            </p>
          </section>
          <section>
            <h4 className="font-semibold text-gray-900">No Tracking</h4>
            <p>
              When analytics is disabled (the default), no usage data is collected. If enabled, only anonymous,
              aggregated statistics are gathered.
            </p>
          </section>
          <section>
            <h4 className="font-semibold text-gray-900">Your Rights</h4>
            <p>
              You can delete all your data at any time using the "Clear Scan History" or "Reset to Defaults" options in
              Settings.
            </p>
          </section>
        </div>
      </Modal>

      <Modal isOpen={showTermsModal} onClose={() => setShowTermsModal(false)} title="Terms of Service" size="lg">
        <div className="space-y-4 text-sm text-gray-600 max-h-[60vh] overflow-y-auto">
          <p className="font-medium text-gray-900">Last updated: September 2026</p>
          <section>
            <h4 className="font-semibold text-gray-900">Screening Tool Only</h4>
            <p>
              PharmaTrace is a screening tool, not a medical device. It does not prove chemical contents or replace
              laboratory testing.
            </p>
          </section>
          <section>
            <h4 className="font-semibold text-gray-900">No Medical Advice</h4>
            <p>Results should not be used for medical decisions. Consult a pharmacist or healthcare professional.</p>
          </section>
          <section>
            <h4 className="font-semibold text-gray-900">Accuracy Limitations</h4>
            <p>
              Results depend on image quality, lighting, and database completeness. False positives and negatives can
              occur.
            </p>
          </section>
          <section>
            <h4 className="font-semibold text-gray-900">No Liability</h4>
            <p>The developers are not liable for any decisions made based on PharmaTrace results.</p>
          </section>
          <section className="p-3 rounded-xl bg-warning-50 border border-warning-200">
            <p className="text-warning-800">{disclaimerText}</p>
          </section>
        </div>
      </Modal>
    </div>
  );
}
