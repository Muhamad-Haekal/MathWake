import { DarkTheme, DefaultTheme, Stack, ThemeProvider, router, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Platform, useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthProvider, useAuth } from '@/contexts/auth-context';
import {
  consumePendingAlarmToReminder,
  initAlarmAutoStart,
  initChallengeNotificationHandler,
  type AlarmEntryDeps,
} from '@/lib/scheduling';
import { supabase } from '@/lib/supabase';
import { getNativeAlarmStatus } from '@/lib/alarm-native';
import { getSchedulePermission } from '@/lib/scheduling';
import { startAuthCallbackHandling } from '@/lib/auth-oauth';
import { loadAlarmEditorDraft, shouldResumeAlarmEditor } from '@/lib/alarm-editor-draft';

SplashScreen.preventAutoHideAsync();

// ---------------------------------------------------------------------------
// Shared challenge-entry dependencies for every notification/alarm path.
// Module scope (no hooks): safe to call from effects and listeners.
// ---------------------------------------------------------------------------

function buildAlarmEntryDeps(): AlarmEntryDeps {
  const getUserId = async () =>
    (await supabase.auth.getUser()).data.user?.id ?? null;

  return {
    getUserId,
    fetchAlarmConfig: async (userId: string, alarmId: string) => {
      const { data } = await supabase
        .from('alarms')
        .select('difficulty,question_count,title')
        .eq('id', alarmId)
        .eq('user_id', userId)
        .single();
      if (!data) return null;
      const row = data as { difficulty?: unknown; question_count?: unknown; title?: unknown };
      return {
        difficulty: typeof row.difficulty === 'string' ? row.difficulty : 'sedang',
        question_count:
          typeof row.question_count === 'number' && row.question_count >= 1
            ? row.question_count
            : 3,
        title: typeof row.title === 'string' ? row.title.trim().slice(0, 40) || 'Alarm' : 'Alarm',
      };
    },
    navigateToReminder: (params: {
      alarmId: string;
      alarmTitle: string;
      difficulty: string;
      questionCount: string;
      timeLimitSeconds: string;
      maxMistakes: string;
      eventId: string;
      generation: string;
      triggerAtMs: string;
    }) => {
      // replace (not push): alarm entry points can fire while a challenge is
      // already open (auto-launch + tap, double tap). Stacking two challenge
      // screens would force the user to solve twice — and the second mount
      // would restart the audio after the first solve stopped it.
      router.replace({ pathname: '/alarm-reminder', params });
    },
  };
}

// ---------------------------------------------------------------------------
// Root layout — wraps the whole app in AuthProvider and ThemeProvider.
// The navigator lives in a child component so it can read the auth context.
// ---------------------------------------------------------------------------

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <AuthProvider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AnimatedSplashOverlay />
        <RootNavigator />
      </ThemeProvider>
    </AuthProvider>
  );
}

// ---------------------------------------------------------------------------
// RootNavigator reads the session and applies Stack.Protected guards.
// While isLoading is true the splash overlay is still covering the screen,
// so we render nothing to avoid a flash of unauthenticated content.
// ---------------------------------------------------------------------------

function RootNavigator() {
  const pathname = usePathname();
  const {
    session,
    isLoading,
    profile,
    profileLoading,
    profileError,
    onboardingRequired,
    recoveryActive,
  } = useAuth();

  useEffect(() => startAuthCallbackHandling((result) => {
    if (result.success) {
      // PASSWORD_RECOVERY from AuthProvider is the authority for entering the
      // password form. The callback result must not race that state transition.
      return;
    }

    const recovery = result.kind === 'recovery' || result.kind === 'unknown';
    Alert.alert(
      recovery ? 'Tautan pemulihan' : 'Login Google',
      result.message ?? (recovery
        ? 'Tautan tidak dapat diproses atau sudah kedaluwarsa. Minta tautan reset baru.'
        : 'Login Google gagal. Coba lagi.'),
      [
        {
          text: recovery ? 'Minta tautan baru' : 'Kembali ke login',
          onPress: () => router.replace(recovery ? '/password-recovery' : '/auth/login'),
        },
        ...(recovery ? [{ text: 'Tutup', style: 'cancel' as const }] : []),
      ],
    );
  }), []);

  useEffect(() => {
    // In supabase-js 2.117.3 exchangeCodeForSession does not return redirectType;
    // AuthContext sets this flag only after the SDK emits PASSWORD_RECOVERY.
    if (recoveryActive) router.replace('/password-recovery');
  }, [recoveryActive]);

  // Keep the root permission snapshot current for alarm entry paths and for
  // returning from Android Settings, but intentionally render no onboarding
  // modal here. The Alarm screen remains the user-facing permission surface.
  const [, setPermissionState] = useState<{
    notification: boolean;
    exact: boolean;
    fullScreen: boolean;
    available: boolean;
  } | null>(null);
  const permissionRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alarmDraftRestoreChecked = useRef(false);

  useEffect(() => {
    if (
      alarmDraftRestoreChecked.current
      || isLoading
      || !session
      || recoveryActive
      || profileLoading
      || profileError
      || onboardingRequired
      || profile?.id !== session.user.id
      || !shouldResumeAlarmEditor(pathname)
    ) return;

    alarmDraftRestoreChecked.current = true;
    if (pathname === '/alarms') return;
    void loadAlarmEditorDraft(session.user.id).then((draft) => {
      if (draft) {
        console.info('[MathWakeDiag]', {
          stage: 'editor.route.restored',
          timestampMs: Date.now(),
        });
        router.replace('/alarms' as never);
      }
    });
  }, [isLoading, onboardingRequired, pathname, profile?.id, profileError, profileLoading, recoveryActive, session]);

  const refreshPermissionState = useCallback(async () => {
    if (!session || Platform.OS !== 'android') {
      setPermissionState(null);
      return;
    }
    try {
      const [permission, native] = await Promise.all([
        getSchedulePermission(),
        getNativeAlarmStatus(),
      ]);
      setPermissionState({
        notification: permission === 'granted',
        exact: native.canScheduleExactAlarms,
        fullScreen: native.canUseFullScreenIntent,
        available: native.available,
      });
    } catch {
      setPermissionState(null);
    }
  }, [session]);

  useEffect(() => {
    void Promise.resolve().then(refreshPermissionState);
  }, [refreshPermissionState]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void refreshPermissionState();
      if (permissionRetryTimer.current !== null) clearTimeout(permissionRetryTimer.current);
      permissionRetryTimer.current = setTimeout(() => {
        permissionRetryTimer.current = null;
        void refreshPermissionState();
      }, 350);
    });
    return () => {
      subscription.remove();
      if (permissionRetryTimer.current !== null) clearTimeout(permissionRetryTimer.current);
    };
  }, [refreshPermissionState]);

  // Install alarm notification handlers EARLY (root mount), not in a tab
  // screen. A tab screen's effect only runs after the user visits that tab,
  // so a cold-start tap or a tap while on another tab would otherwise do
  // nothing: no audio, no challenge navigation. All inits below are
  // idempotent (installed at most once per process), so the alarms tab may
  // safely register them again.
  useEffect(() => {
    const alarmEntryDeps = buildAlarmEntryDeps();

    initChallengeNotificationHandler(alarmEntryDeps).catch(() => undefined);
    initAlarmAutoStart(alarmEntryDeps).catch(() => undefined);
  }, []);

  // Native exact-alarm cold start: the receiver marks every fire, so an app
  // launched by the full-screen intent routes to the challenge as soon as
  // the session is ready — without waiting for any tap. Runs on every
  // sign-in; consume is one-shot and recency-gated, and challenge entry is
  // de-duplicated, so re-runs are harmless.
  useEffect(() => {
    if (!session) return;
    consumePendingAlarmToReminder(buildAlarmEntryDeps()).catch(() => undefined);
  }, [session]);

  if (isLoading || (!!session && profileLoading && !recoveryActive)) {
    // Return null while the splash overlay is on screen; avoids a white flash.
    return null;
  }

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
      {/* Keep login as the signed-out fallback; recovery remains directly reachable. */}
      <Stack.Protected guard={!session}>
        <Stack.Screen name="auth" />
      </Stack.Protected>
      {/* Authenticated group — only accessible when a session exists */}
      <Stack.Protected guard={!!session && !recoveryActive && !profileLoading && !profileError && !onboardingRequired && profile?.id === session.user.id}>
        <Stack.Screen name="(app)" />
        <Stack.Screen name="profile" />
        <Stack.Screen
          name="alarm-reminder"
          options={{
            gestureEnabled: false,
            animation: 'fade',
          }}
        />
        {/* Math Challenge — full screen, session required, no tab bar */}
        <Stack.Screen
          name="challenge"
          options={{
            gestureEnabled: false,
            animation: 'slide_from_bottom',
          }}
        />
      </Stack.Protected>

      <Stack.Protected guard={!!session && !recoveryActive && !profileLoading && (onboardingRequired || !!profileError || !profile)}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>

      {/* Keep this public request route after the authenticated landing routes.
          Otherwise it becomes the first available fallback when login is
          removed from the stack by its guard. The password form still requires
          a verified PASSWORD_RECOVERY session. */}
      <Stack.Screen name="password-recovery" />

      </Stack>
    </>
  );
}
