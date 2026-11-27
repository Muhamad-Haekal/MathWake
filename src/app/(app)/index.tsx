import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NextAlarmCard } from '@/components/home/next-alarm-card';
import { TodayStats } from '@/components/home/today-stats';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/auth-context';
import { useHomeData } from '@/hooks/use-home-data';
import { useTheme } from '@/hooks/use-theme';
import { greetingForDate } from '@/lib/greeting';
import { formatFullDateID, msUntilNextMinute, nextAlarmFromList, resolveHomeSnooze } from '@/lib/home-data';
import {
  getNativeActiveAlarmEvent,
  getNativeActiveAlarmId,
  getNativeAlarmEvent,
  getNativeLiveScheduledSnoozes,
} from '@/lib/alarm-native';
import { isAlarmAudioPlaying } from '@/lib/alarm-audio';
import { resolveActiveAlarm, type ActiveAlarmState } from '@/lib/alarm-active-state';
import { getAlarmSession, type AlarmSession } from '@/lib/alarm-session';
import { buildActiveChallengeParams, resolveActiveChallengeOccurrence } from '@/lib/active-challenge-entry';
import { normalizeAlarmTitle } from '@/lib/alarms';
import { supabase } from '@/lib/supabase';
import type { NativeAlarmEvent } from '../../../modules/mathwake-alarm/src/types';
import type { AlarmRow } from '@/lib/home-data';
import { router, useFocusEffect } from 'expo-router';

// ---------------------------------------------------------------------------
// Home dashboard. All sections render real Supabase data (alarms,
// alarm_logs, attempts) with
// skeleton loading, truthful empty states, and an inline error + retry.
// ---------------------------------------------------------------------------

export default function HomeScreen() {
  const { signOut, user, profile } = useAuth();
  const { data, isLoading, isRefreshing, error, refresh } = useHomeData();
  const [active, setActive] = useState<ActiveAlarmState | null>(null);
  const [scheduledSnoozes, setScheduledSnoozes] = useState<NativeAlarmEvent[]>([]);
  const [snoozedAlarmRow, setSnoozedAlarmRow] = useState<AlarmRow | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [openingChallenge, setOpeningChallenge] = useState(false);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const openingChallengeRef = useRef(false);
  const theme = useTheme();

  const refreshActive = useCallback(async () => {
    const [nativeId, session, snoozes] = await Promise.all([
      getNativeActiveAlarmId(),
      getAlarmSession(),
      getNativeLiveScheduledSnoozes(),
    ]);
    setScheduledSnoozes(snoozes);
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

  // `now` is refreshed on every minute boundary and on app foreground, so the
  // greeting flips exactly at 05:00 / 11:00 / 15:00 / 18:00 local time.
  const greeting = greetingForDate(now);
  const displayName = profile?.display_name?.trim() || null;
  const initial = (displayName ?? user?.email ?? '?').trim().charAt(0).toUpperCase();
  const todayLabel = formatFullDateID(now);
  const scheduledSnooze = resolveHomeSnooze(
    scheduledSnoozes,
    [...(data?.activeAlarms ?? []), ...(snoozedAlarmRow ? [snoozedAlarmRow] : [])],
    now,
  );

  useEffect(() => {
    const pending = scheduledSnoozes
      .filter((event) => event.triggerAtMs > Date.now())
      .sort((a, b) => a.triggerAtMs - b.triggerAtMs)[0];
    if (!pending || !user?.id) return;
    if (snoozedAlarmRow?.id === pending.alarmId) return;
    const loaded = data?.activeAlarms.find((alarm) => alarm.id === pending.alarmId);
    if (loaded) return;
    let current = true;
    void (async () => {
      const { data: row, error: queryError } = await supabase
        .from('alarms')
        .select('id,user_id,time,days,title,is_active,is_recurring,difficulty,question_count,preset,snooze_minutes,created_at')
        .eq('id', pending.alarmId)
        .eq('user_id', user.id)
        .maybeSingle();
      if (current && !queryError && row) setSnoozedAlarmRow(row as AlarmRow);
    })();
    return () => { current = false; };
  }, [data?.activeAlarms, scheduledSnoozes, snoozedAlarmRow?.id, user?.id]);

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
              <ThemedText themeColor="textSecondary" style={styles.dateText}>{todayLabel}</ThemedText>
              <ThemedText style={styles.greeting} accessibilityRole="header">{greeting}</ThemedText>
              {displayName ? (
                <ThemedText themeColor="textSecondary" style={styles.nameText}>{displayName}</ThemedText>
              ) : null}
            </View>
            <Pressable
              onPress={() => router.push('/profile' as never)}
              accessibilityRole="button"
              accessibilityLabel="Buka profil"
              hitSlop={8}
              style={({ pressed }) => [styles.avatar, { backgroundColor: theme.primarySoft, borderColor: theme.border }, pressed && styles.pressed]}>
              <ThemedText style={[styles.avatarText, { color: theme.primaryStrong }]}>{initial}</ThemedText>
            </Pressable>
          </View>

          {isLoading ? (
            <HomeSkeleton />
          ) : error || !data ? (
            <View style={[styles.errorCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]} accessibilityRole="alert">
              <View style={[styles.errorIcon, { backgroundColor: theme.dangerSoft }]}>
                <SymbolView name={{ ios: 'wifi.exclamationmark', android: 'cloud_off', web: 'cloud_off' }} size={22} tintColor={theme.danger} />
              </View>
              <ThemedText style={styles.errorTitle}>Gagal memuat data</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.errorBody}>
                {error ?? 'Terjadi kesalahan. Coba lagi nanti.'}
              </ThemedText>
              <Pressable
                style={({ pressed }) => [styles.retryButton, { borderColor: theme.border }, pressed && styles.pressed]}
                onPress={refresh}
                accessibilityRole="button"
                accessibilityLabel="Coba muat ulang">
                <SymbolView name={{ ios: 'arrow.clockwise', android: 'refresh', web: 'refresh' }} size={18} tintColor={theme.text} />
                <ThemedText style={styles.retryText}>Coba lagi</ThemedText>
              </Pressable>
            </View>
          ) : (
            <View style={styles.sections}>
              <NextAlarmCard
                nextAlarm={nextAlarmFromList(data.activeAlarms, now)}
                snoozedAlarm={scheduledSnooze}
                activeCount={data.activeAlarms.length}
                now={now}
                active={active}
                activeAlarmRow={active ? data.activeAlarms.find((alarm) => alarm.id === active.alarmId) ?? null : null}
                openingChallenge={openingChallenge}
                challengeError={challengeError}
                onContinueActiveChallenge={() => { void continueActiveChallenge(); }}
                onOpenAlarms={() => router.push('/alarms' as never)}
              />
              <TodayStats
                alarmsRang={data.logsToday}
                attemptsTotal={data.attemptsToday.total}
                attemptsCorrect={data.attemptsToday.correct}
                attemptsUnavailable={data.attemptsUnavailable}
              />
            </View>
          )}

          {/* Account: kept on Home (existing behaviour), visually separated from content. */}
          <View style={[styles.accountRow, { borderColor: theme.border }]}>
            {user?.email ? (
              <ThemedText themeColor="textSecondary" style={styles.emailText}>{user.email}</ThemedText>
            ) : <View style={styles.flex} />}
            <Pressable
              onPress={handleSignOut}
              disabled={signingOut}
              accessibilityRole="button"
              accessibilityLabel="Keluar dari akun"
              accessibilityState={{ disabled: signingOut, busy: signingOut }}
              hitSlop={8}
              style={({ pressed }) => [styles.signOutButton, pressed && styles.pressed]}>
              <SymbolView name={{ ios: 'rectangle.portrait.and.arrow.right', android: 'logout', web: 'logout' }} size={16} tintColor={theme.danger} />
              <ThemedText style={[styles.signOutText, { color: theme.danger }]}>
                {signingOut ? 'Keluar...' : 'Keluar'}
              </ThemedText>
            </Pressable>
          </View>
          {signOutError ? (
            <ThemedText type="small" style={{ color: theme.danger }} accessibilityRole="alert">{signOutError}</ThemedText>
          ) : null}
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
      <View style={styles.skeletonRow}>
        <View style={[styles.skeletonCell, block]} />
        <View style={[styles.skeletonCell, block]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  flex: { flex: 1 },
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
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  headerText: { flex: 1, minWidth: 0, gap: 2 },
  dateText: { fontSize: 14, fontWeight: '600' },
  greeting: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  nameText: { fontSize: 16, fontWeight: '500' },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 19, fontWeight: '800' },
  sections: { gap: Spacing.four },
  errorCard: {
    borderRadius: Radius.block,
    borderWidth: 1,
    padding: Spacing.four,
    gap: Spacing.two,
    alignItems: 'flex-start',
  },
  errorIcon: { width: 44, height: 44, borderRadius: Radius.control, alignItems: 'center', justifyContent: 'center' },
  errorTitle: { fontSize: 17, fontWeight: '700' },
  errorBody: { lineHeight: 20 },
  retryButton: {
    alignSelf: 'stretch',
    minHeight: 48,
    borderWidth: 1,
    borderRadius: Radius.control,
    flexDirection: 'row',
    gap: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.two,
  },
  retryText: { fontSize: 16, fontWeight: '700' },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.three,
    marginTop: Spacing.two,
  },
  emailText: { flex: 1, minWidth: 0, fontSize: 13 },
  signOutButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: Spacing.one, paddingHorizontal: Spacing.two },
  signOutText: { fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.8 },
  skeletonHero: { height: 196, borderRadius: Radius.block + 4 },
  skeletonLine: { height: 24, width: 96, borderRadius: Radius.control },
  skeletonRow: { flexDirection: 'row', gap: Spacing.three },
  skeletonCell: { flex: 1, height: 120, borderRadius: Radius.block },
});
