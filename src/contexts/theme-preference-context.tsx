import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from 'react-native';
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type PropsWithChildren } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

const THEME_PREFERENCE_KEY = '@mathwake/theme-preference';

type ThemePreferenceContextValue = {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => Promise<void>;
};

export const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Terang' },
  { value: 'dark', label: 'Gelap' },
  { value: 'system', label: 'Sistem' },
];

const ThemePreferenceContext = createContext<ThemePreferenceContextValue | null>(null);

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

function applyPreference(preference: ThemePreference) {
  Appearance.setColorScheme(preference === 'system' ? 'unspecified' : preference);
}

export function ThemePreferenceProvider({ children }: PropsWithChildren) {
  const [preference, setPreferenceState] = useState<ThemePreference>('light');

  useLayoutEffect(() => {
    let active = true;
    applyPreference('light');

    void AsyncStorage.getItem(THEME_PREFERENCE_KEY).then((stored) => {
      if (!active) return;
      const next = isThemePreference(stored) ? stored : 'light';
      setPreferenceState(next);
      applyPreference(next);
    }).catch(() => {
      if (active) applyPreference('light');
    });

    return () => { active = false; };
  }, []);

  const setPreference = useCallback(async (next: ThemePreference) => {
    setPreferenceState(next);
    applyPreference(next);
    try {
      await AsyncStorage.setItem(THEME_PREFERENCE_KEY, next);
    } catch {
      // Keep the selected theme for this session if local persistence fails.
    }
  }, []);

  const value = useMemo(() => ({ preference, setPreference }), [preference, setPreference]);

  return <ThemePreferenceContext.Provider value={value}>{children}</ThemePreferenceContext.Provider>;
}

export function useThemePreference() {
  const value = useContext(ThemePreferenceContext);
  if (!value) throw new Error('useThemePreference must be used within ThemePreferenceProvider');
  return value;
}
