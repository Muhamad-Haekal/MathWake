import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Accent, BottomTabInset, MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  createTimerState,
  getTimerRemainingMs,
  loadTimerState,
  pauseTimer,
  resetTimer,
  resumeTimer,
  saveTimerState,
  settleTimer,
  startTimer,
  type TimerState,
} from '@/lib/timer';
import { cancelNativeTimer, scheduleNativeTimer } from '@/lib/timer-native';
import { ensureSchedulePermission } from '@/lib/scheduling';

const DEFAULT_DURATION_MS = 5 * 60 * 1000;

function formatTimer(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

export default function TimerScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const mounted = useRef(true);
  const notificationPermissionRequested = useRef(false);
  const [state, setState] = useState<TimerState | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [durationInput, setDurationInput] = useState('5');
  const [error, setError] = useState<string | null>(null);
  const nativeTimerStatus = state?.status;
  const nativeTimerDeadlineMs = state?.deadlineMs;

  useEffect(() => {
    if (Platform.OS !== 'android' || notificationPermissionRequested.current) return;
    notificationPermissionRequested.current = true;
    void ensureSchedulePermission().then((permission) => {
      if (!mounted.current) return;
      if (permission === 'denied') {
        setError('Izin notifikasi ditolak. Timer tetap berjalan, tetapi notifikasi selesai tidak dapat ditampilkan.');
      } else if (permission === 'unavailable') {
        setError('Izin notifikasi tidak tersedia di build ini. Gunakan development build atau APK.');
      }
    });
  }, []);

  const persist = useCallback(async (next: TimerState) => {
    try {
      await saveTimerState(next);
      if (next.status === 'running' && next.deadlineMs !== null) {
        void scheduleNativeTimer(next.deadlineMs);
      } else {
        void cancelNativeTimer();
      }
    } catch {
      if (mounted.current) setError('Timer tidak dapat disimpan. Coba lagi nanti.');
    }
  }, []);

  useEffect(() => {
    if (nativeTimerStatus === 'running' && nativeTimerDeadlineMs !== null && nativeTimerDeadlineMs !== undefined) {
      void scheduleNativeTimer(nativeTimerDeadlineMs);
    } else {
      void cancelNativeTimer();
    }
  }, [nativeTimerDeadlineMs, nativeTimerStatus]);

  useEffect(() => {
    mounted.current = true;
    void loadTimerState().then((saved) => {
      if (!mounted.current) return;
      const next = saved ?? createTimerState(DEFAULT_DURATION_MS);
      setState(next);
      setDurationInput(String(Math.max(1, Math.round(next.durationMs / 60000))));
    });
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') setNowMs(Date.now());
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (state?.status !== 'running') return;
    const tick = () => {
      const currentNow = Date.now();
      setNowMs(currentNow);
      setState((current) => {
        if (!current) return current;
        const next = settleTimer(current, currentNow);
        if (next !== current) void persist(next);
        return next;
      });
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [persist, state?.status]);

  function updateState(transform: (current: TimerState, now: number) => TimerState) {
    setError(null);
    setState((current) => {
      if (!current) return current;
      const next = transform(current, Date.now());
      if (next !== current) void persist(next);
      return next;
    });
  }

  function applyDuration() {
    const minutes = Number(durationInput.trim());
    if (!Number.isInteger(minutes) || minutes <= 0) {
      setError('Masukkan durasi dalam menit yang lebih dari 0.');
      return;
    }
    setError(null);
    const next = createTimerState(minutes * 60000);
    setState(next);
    void persist(next);
  }

  if (!state) {
    return (
      <ThemedView style={styles.center}>
        <ActivityIndicator color={Accent} />
        <ThemedText type="small" themeColor="textSecondary">Memuat Timer…</ThemedText>
      </ThemedView>
    );
  }

  const remainingMs = getTimerRemainingMs(state, nowMs);
  const editingDisabled = state.status === 'running' || state.status === 'paused';
  const buttonLabel = state.status === 'running' ? 'Pause' : state.status === 'paused' ? 'Resume' : 'Start';

  return (
    <ThemedView style={styles.container}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + Spacing.four, paddingBottom: insets.bottom + BottomTabInset + Spacing.four }}
        showsVerticalScrollIndicator={false}>
        <View style={styles.inner}>
          <ThemedText type="subtitle">Timer</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Timer memakai notifikasi Android saat selesai. Suara belum tersedia.
          </ThemedText>

          <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
            <ThemedText style={styles.clock}>{formatTimer(remainingMs)}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {state.status === 'finished' ? 'Selesai' : state.status === 'running' ? 'Berjalan' : state.status === 'paused' ? 'Dijeda' : 'Siap'}
            </ThemedText>
          </View>

          <View style={styles.durationRow}>
            <TextInput
              value={durationInput}
              onChangeText={setDurationInput}
              keyboardType="number-pad"
              editable={!editingDisabled}
              accessibilityLabel="Durasi timer dalam menit"
              style={[styles.input, { color: theme.text, borderColor: theme.backgroundSelected }]}
            />
            <ThemedText type="small">menit</ThemedText>
            <Pressable
              onPress={applyDuration}
              disabled={editingDisabled}
              accessibilityRole="button"
              accessibilityLabel="Terapkan durasi timer"
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, editingDisabled && styles.disabled]}>
              <ThemedText type="smallBold">Terapkan</ThemedText>
            </Pressable>
          </View>

          {error ? <ThemedText type="small" style={styles.error}>{error}</ThemedText> : null}
          {state.status === 'finished' ? (
            <ThemedText type="small" themeColor="textSecondary">Waktu habis. Notifikasi suara belum tersedia.</ThemedText>
          ) : null}

          <View style={styles.actions}>
            <Pressable
              onPress={() => updateState((current, now) => current.status === 'running' ? pauseTimer(current, now) : current.status === 'paused' ? resumeTimer(current, now) : startTimer(current, now))}
              disabled={state.status === 'finished'}
              accessibilityRole="button"
              accessibilityLabel={buttonLabel}
              style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, state.status === 'finished' && styles.disabled]}>
              <ThemedText style={styles.primaryText}>{buttonLabel}</ThemedText>
            </Pressable>
            <Pressable
              onPress={() => updateState((current) => resetTimer(current))}
              accessibilityRole="button"
              accessibilityLabel="Reset timer"
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
              <ThemedText type="smallBold">Reset</ThemedText>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
  inner: { width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center', paddingHorizontal: Spacing.four, gap: Spacing.three },
  card: { borderRadius: Radius.block, alignItems: 'center', paddingVertical: Spacing.six, gap: Spacing.one },
  clock: { fontSize: 48, lineHeight: 56, fontWeight: '700', fontVariant: ['tabular-nums'] },
  durationRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  input: { minWidth: 80, borderWidth: 1, borderRadius: Radius.control, paddingHorizontal: Spacing.two, paddingVertical: Spacing.two, textAlign: 'center', fontSize: 18 },
  actions: { flexDirection: 'row', gap: Spacing.two },
  primaryButton: { flex: 1, backgroundColor: Accent, borderRadius: Radius.control, alignItems: 'center', paddingVertical: Spacing.three },
  primaryText: { color: '#fff', fontWeight: '700' },
  secondaryButton: { borderRadius: Radius.control, paddingHorizontal: Spacing.three, paddingVertical: Spacing.three, backgroundColor: '#00000012', alignItems: 'center' },
  error: { color: '#d33', lineHeight: 20 },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 },
});
