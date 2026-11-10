import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabasePublishableKey =
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    'Supabase environment variables are not configured.',
  );
}

export const supabase = createClient(
  supabaseUrl,
  supabasePublishableKey,
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
  },
);

let authLifecycleCleanup: (() => void) | null = null;

/** Registers the single React Native lifecycle bridge for Supabase Auth. */
export function registerSupabaseAuthLifecycle(): () => void {
  if (Platform.OS === 'web' || authLifecycleCleanup) return () => undefined;

  const handleAppStateChange = (state: string) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  };

  const subscription = AppState.addEventListener('change', handleAppStateChange);
  handleAppStateChange(AppState.currentState ?? 'background');

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    subscription.remove();
    supabase.auth.stopAutoRefresh();
    authLifecycleCleanup = null;
  };
  authLifecycleCleanup = cleanup;
  return cleanup;
}
