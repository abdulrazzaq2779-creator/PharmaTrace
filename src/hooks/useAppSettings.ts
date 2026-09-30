import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppSettings } from '../types';
import { defaultSettings } from '../types';
import { loadSettings, saveSettings } from '../services/storage';

const MEDIA_QUERY = '(prefers-color-scheme: dark)';

/**
 * App-wide settings stored as one localStorage object and shared via props.
 * Keeps them in sync with the prefers-color-scheme media query while theme is "system".
 */
export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia(MEDIA_QUERY).matches
  );

  useEffect(() => {
    const media = window.matchMedia(MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const isDark = settings.theme === 'dark' || (settings.theme === 'system' && systemPrefersDark);
    root.classList.toggle('dark', isDark);

    root.classList.toggle('motion-reduce', settings.reducedMotion);
    root.classList.toggle('contrast-high', settings.highContrast);
    root.classList.toggle('text-large', settings.largeText);

    try {
      saveSettings(settings);
    } catch {
      // Storage full or unavailable; in-memory settings still apply for this session.
    }
  }, [settings, systemPrefersDark]);

  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  const resetSettings = useCallback(() => {
    setSettings(defaultSettings);
    try {
      saveSettings(defaultSettings);
    } catch {
      // Ignore — nothing else to do.
    }
  }, []);

  return useMemo(
    () => ({ settings, updateSetting, resetSettings }),
    [settings, updateSetting, resetSettings]
  );
}
