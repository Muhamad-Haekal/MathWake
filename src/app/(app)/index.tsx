import { useCallback, useRef, useState } from 'react';
import { Alert, AppState, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NextAlarmCard } from '@/components/home/next-alarm-card';
import { TodayStats } from '@/components/home/today-stats';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Danger, MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/auth-context';
import { useHomeData } from '@/hooks/use-home-data';
import { useTheme } from '@/hooks/use-theme';
import { formatFullDateID, greetingForHour, msUntilNextMinute, nextAlarmFromList } from '@/lib/home-data';
import {
  getNativeActiveAlarmEvent,
  getNativeActiveAlarmId,
  getNativeAlarmEvent,
} from '@/lib/alarm-native';
import { isAlarmAudioPlaying } from '@/lib/alarm-audio';
import { resolveActiveAlarm, type ActiveAlarmState } from '@/lib/alarm-active-state';
import { getAlarmSession, type AlarmSession } from '@/lib/alarm-session';
import { buildActiveChallengeParams, resolveActiveChallengeOccurrence } from '@/lib/active-challenge-entry';
import { normalizeAlarmTitle } from '@/lib/alarms';
import { supabase } from '@/lib/supabase';
import type { NativeAlarmEvent } from '../../../modules/mathwake-alarm/src/types';
import { router, useFocusEffect } from 'expo-router';

// ---------------------------------------------------------------------------
// Home dashboard. All sections render real Supabase data (alarms,
// alarm_logs, attempts) with
// skeleton loading, truthful empty states, and an inline error + retry.
// ---------------------------------------------------------------------------

export default function HomeScreen() {
  const { signOut, user } = useAuth();
  const { data, isLoading, isRefreshing, error, refresh } = useHomeData();
  const [active, setActive] = useState<ActiveAlarmState | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [openingChallenge, setOpeningChallenge] = useState(false);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const openingChallengeRef = useRef(false);
  const theme = useTheme();

  const refreshActive = useCallback(async () => {
    const [nativeId, session] = await Promise.all([getNativeActiveAlarmId(), getAlarmSession()]);
    const current = new Date();
    setNow(current);
    setActive(resolveActiveAlarm({
      nativeActiveId: nativeId,
      session,
      jsAudioPlaying: session ? isAlarmAudioPlaying(session.alarmId, session.eventId) : false,
      nowMs: current.getTime(),
    }));
  }, []);

  const readChallengeEvidence = useCallback(async (alarmId: string) => {
    const [nativeId, session] = await Promise.all([getNativeActiveAlarmId(), getAlarmSession()]);
    let nativeOwner: Awaited<ReturnType<typeof getNativeActiveAlarmEvent>> = null;
    let nativeEvent: NativeAlarmEvent | null = null;
    if (nativeId === alarmId) {
      nativeOwner = await getNativeActiveAlarmEvent();
      if (nativeOwner?.alarmId === alarmId) {
        const event = await getNativeAlarmEvent(nativeOwner.eventId);
        if (event?.eventId === nativeOwner.eventId && event.generation === nativeOwner.generation) nativeEvent = event;
      }
    }
    const jsAudioPlaying = session ? isAlarmAudioPlaying(session.alarmId, session.eventId) : false;
    return {
      nativeId,
      nativeOwner,
      session,
      occurrence: resolveActiveChallengeOccurrence({
        alarmId,
        nativeActiveId: nativeId,
        nativeOwner,
        nativeEvent,
        session,
        jsAudioPlaying,
        nowMs: Date.now(),
      }),
    };
  }, []);

  const continueActiveChallenge = useCallback(async () => {
    if (!active || openingChallengeRef.current) return;
    openingChallengeRef.current = true;
    setOpeningChallenge(true);
    setChallengeError(null);
    try {
      const first = await readChallengeEvidence(active.alarmId);
      if (!first.occurrence) throw new Error('Alarm ini sudah tidak berbunyi atau sesi tantangannya sudah berakhir. Muat ulang Home untuk memeriksa status terbaru.');
      if (!user?.id) throw new Error('Sesi akun tidak tersedia. Masuk kembali lalu coba lagi.');

      const { data: row, error: fetchError } = await supabase
        .from('alarms')
        .select('is_active,title,difficulty,question_count')
        .eq('id', active.alarmId)
        .eq('user_id', user.id)
        .maybeSingle();
      if (fetchError) throw new Error('Konfigurasi alarm tidak dapat dimuat. Periksa koneksi lalu coba lagi.');
      // is_active describes whether this schedule should fire again. A one-time
      // alarm is disabled after it fires, while its native occurrence can still
      // be ringing and waiting for this challenge.
      if (!row) throw new Error('Alarm ini tidak ditemukan atau bukan milik akun ini. Tantangan tidak dapat dibuka.');

      const latest = await readChallengeEvidence(active.alarmId);
      if (!latest.occurrence || latest.occurrence.eventId !== first.occurrence.eventId || latest.occurrence.generation !== first.occurrence.generation) {
        throw new Error('Alarm aktif telah berubah. Muat ulang Home sebelum membuka tantangan.');
      }

      const session: AlarmSession | null = latest.session?.alarmId === active.alarmId
        && latest.session.eventId === latest.occurrence.eventId
        && latest.session.generation === latest.occurrence.generation
        ? latest.session
        : null;
      router.replace({
        pathname: '/challenge',
        params: buildActiveChallengeParams(latest.occurrence, {
          title: normalizeAlarmTitle(row.title),
          difficulty: session?.difficulty ?? row.difficulty,
          questionCount: session?.questionCount ?? row.question_count,
          timeLimitSeconds: session?.timeLimitSeconds,
          maxMistakes: session?.maxMistakes,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tantangan tidak dapat dibuka. Coba lagi.';
      setChallengeError(message);
      if (/sudah tidak berbunyi|sudah tidak aktif|sesi tantangannya sudah berakhir/.test(message)) {
        setActive(null);
        void refreshActive();
        void refresh();
      }
    } finally {
      openingChallengeRef.current = false;
      setOpeningChallenge(false);
    }
  }, [active, readChallengeEvidence, refresh, refreshActive, user]);

  useFocusEffect(
    useCallback(() => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const tick = () => {
        void refreshActive();
        timer = setTimeout(tick, msUntilNextMinute(new Date()));
      };
      tick();
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') void refreshActive();
      });
      return () => {
        if (timer !== null) clearTimeout(timer);
        sub.remove();
      };
    }, [refreshActive]),
  );
  const insets = useSafeAreaInsets();

  const greeting = greetingForHour(now.getHours());
  const todayLabel = formatFullDateID(now);

  // Refresh when returning from the Alarm tab so edits show immediately.
  // The first focus is skipped because the initial load already ran.
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      refresh();
    }, [refresh]),
  );

  async function confirmSignOut() {
    setSignOutError(null);
    setSigningOut(true);
    try {
      await signOut();
      router.replace('/auth/login' as never);
    } catch {
      setSignOutError('Tidak dapat keluar dari akun. Periksa koneksi lalu coba lagi.');
    } finally {
      setSigningOut(false);
    }
  }

  function handleSignOut() {
    if (Platform.OS === 'web') {
      void confirmSignOut();
      return;
    }
    Alert.alert('Keluar', 'Yakin ingin keluar dari akun?', [
      { text: 'Batal', style: 'cancel' },
      { text: 'Keluar', style: 'destructive', onPress: () => { void confirmSignOut(); } },
    ]);
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + Spacing.four,
            paddingBottom: insets.bottom + BottomTabInset + Spacing.four,
          },
        ]}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={refresh} />
        }
        showsVerticalScrollIndicator={false}>
        <View style={styles.inner}>
          {/* Greeting + account */}
          <View style={styles.headerRow}>
            <View style={styles.headerText}>
              <ThemedText style={styles.greeting}>{greeting}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {todayLabel}
              </ThemedText>
              {user?.email ? (
                <ThemedText type="small" themeColor="textSecondary">
                  {user.email}
                </ThemedText>
              ) : null}
            </View>
            <View style={styles.headerActions}>
              <Pressable
                onPress={() => router.push('/profile' as never)}
                accessibilityRole="button"
                accessibilityLabel="Buka profil"
                hitSlop={12}>
                <ThemedText type="small" style={styles.profileLinkText}>Profil</ThemedText>
              </Pressable>
              <Pressable
                onPress={handleSignOut}
                disabled={signingOut}
                accessibilityRole="button"
                accessibilityLabel="Keluar dari akun"
                hitSlop={12}>
                <ThemedText type="small" style={styles.signOutText}>
                  {signingOut ? 'Keluar...' : 'Keluar'}
                </ThemedText>
              </Pressable>
            </View>
          </View>
          {signOutError ? <ThemedText type="small" style={styles.signOutError}>{signOutError}</ThemedText> : null}

          {isLoading ? (
            <HomeSkeleton />
          ) : error || !data ? (
            <View style={[styles.errorCard, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="smallBold">Gagal memuat data</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.errorBody}>
                {error ?? 'Terjadi kesalahan. Coba lagi nanti.'}
              </ThemedText>
              <Pressable
                style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}
                onPress={refresh}
                accessibilityRole="button"
                accessibilityLabel="Coba muat ulang">
                <ThemedText type="small" style={styles.retryText}>
                  Coba lagi
                </ThemedText>
              </Pressable>
            </View>
          ) : (
            <View style={styles.sections}>
              <NextAlarmCard
                nextAlarm={nextAlarmFromList(data.activeAlarms, now)}
                activeCount={data.activeAlarms.length}
                now={now}
                active={active}
                activeAlarmRow={active ? data.activeAlarms.find((alarm) => alarm.id === active.alarmId) ?? null : null}
                openingChallenge={openingChallenge}
                challengeError={challengeError}
                onContinueActiveChallenge={() => { void continueActiveChallenge(); }}
              />
              <TodayStats
                alarmsRang={data.logsToday}
                attemptsTotal={data.attemptsToday.total}
                attemptsCorrect={data.attemptsToday.correct}
                attemptsUnavailable={data.attemptsUnavailable}
              />
            </View>
          )}
        </View>
      </ScrollView>
    </ThemedView>
  );
}

/** Skeleton blocks echoing the dashboard shape (no generic spinner). */
function HomeSkeleton() {
  const theme = useTheme();
  const block = { backgroundColor: theme.backgroundElement };
  return (
    <View style={styles.sections} accessibilityLabel="Memuat data">
      <View style={[styles.skeletonHero, block]} />
      <View style={[styles.skeletonLine, block]} />
      <View style={[styles.skeletonLine, block]} />
      <View style={[styles.skeletonLine, block]} />
      <View style={styles.skeletonRow}>
        <View style={[styles.skeletonCell, block]} />
        <View style={[styles.skeletonCell, block]} />
        <View style={[styles.skeletonCell, block]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  content: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  inner: {
    flex: 1,
    maxWidth: MaxContentWidth,
    gap: Spacing.four,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  headerText: {
    flex: 1,
    gap: Spacing.half,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  profileLinkText: {
    color: '#208AEF',
    fontWeight: '700',
    paddingTop: Spacing.one,
  },
  greeting: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  signOutText: {
    color: Danger,
    fontWeight: '700',
    paddingTop: Spacing.one,
  },
  signOutError: {
    color: Danger,
  },
  sections: {
    gap: Spacing.five,
  },
  errorCard: {
    borderRadius: Radius.block,
    padding: Spacing.four,
    gap: Spacing.two,
  },
  errorBody: {
    lineHeight: 20,
  },
  retryButton: {
    backgroundColor: Danger,
    borderRadius: Radius.control,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.one,
  },
  retryText: {
    color: '#ffffff',
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.8,
  },
  skeletonHero: {
    height: 168,
    borderRadius: Radius.block,
  },
  skeletonLine: {
    height: 44,
    borderRadius: Radius.control,
  },
  skeletonRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  skeletonCell: {
    flex: 1,
    height: 84,
    borderRadius: Radius.control,
  },
});
