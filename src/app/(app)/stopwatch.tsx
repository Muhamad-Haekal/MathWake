import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Accent, BottomTabInset, MaxContentWidth, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  createStopwatchState,
  getStopwatchElapsedMs,
  loadStopwatchState,
  pauseStopwatch,
  recordStopwatchLap,
  resetStopwatch,
  resumeStopwatch,
  saveStopwatchState,
  startStopwatch,
  type StopwatchState,
} from '@/lib/stopwatch';

function formatStopwatch(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

export default function StopwatchScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const mounted = useRef(true);
  const [state, setState] = useState<StopwatchState | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  const persist = useCallback(async (next: StopwatchState) => {
    try {
      await saveStopwatchState(next);
    } catch {
      if (mounted.current) setError('Stopwatch tidak dapat disimpan. Coba lagi nanti.');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadStopwatchState().then((saved) => {
      if (mounted.current) setState(saved ?? createStopwatchState());
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
    const interval = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(interval);
  }, [state?.status]);

  function updateState(transform: (current: StopwatchState, now: number) => StopwatchState) {
    setError(null);
    setState((current) => {
      if (!current) return current;
      const next = transform(current, Date.now());
      if (next !== current) void persist(next);
      return next;
    });
  }

  if (!state) {
    return (
      <ThemedView style={styles.center}>
        <ActivityIndicator color={Accent} />
        <ThemedText type="small" themeColor="textSecondary">Memuat Stopwatch…</ThemedText>
      </ThemedView>
    );
  }

  const elapsedMs = getStopwatchElapsedMs(state, nowMs);
  const buttonLabel = state.status === 'running' ? 'Pause' : state.status === 'paused' ? 'Resume' : 'Start';

  return (
    <ThemedView style={styles.container}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + Spacing.four, paddingBottom: insets.bottom + BottomTabInset + Spacing.four }}
        showsVerticalScrollIndicator={false}>
        <View style={styles.inner}>
          <ThemedText type="subtitle">Stopwatch</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Waktu dihitung dari timestamp, bukan dari interval tampilan.
          </ThemedText>

          <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
            <ThemedText style={styles.clock}>{formatStopwatch(elapsedMs)}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {state.status === 'running' ? 'Berjalan' : state.status === 'paused' ? 'Dijeda' : 'Siap'}
            </ThemedText>
          </View>

          {error ? <ThemedText type="small" style={styles.error}>{error}</ThemedText> : null}

          <View style={styles.actions}>
            <Pressable
              onPress={() => updateState((current, now) => current.status === 'running' ? pauseStopwatch(current, now) : current.status === 'paused' ? resumeStopwatch(current, now) : startStopwatch(current, now))}
              accessibilityRole="button"
              accessibilityLabel={buttonLabel}
              style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}>
              <ThemedText style={styles.primaryText}>{buttonLabel}</ThemedText>
            </Pressable>
            <Pressable
              onPress={() => updateState((current) => recordStopwatchLap(current, Date.now()))}
              disabled={state.status === 'idle'}
              accessibilityRole="button"
              accessibilityLabel="Catat lap"
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, state.status === 'idle' && styles.disabled]}>
              <ThemedText type="smallBold">Lap</ThemedText>
            </Pressable>
            <Pressable
              onPress={() => updateState(() => resetStopwatch())}
              accessibilityRole="button"
              accessibilityLabel="Reset stopwatch"
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
              <ThemedText type="smallBold">Reset</ThemedText>
            </Pressable>
          </View>

          <View style={styles.lapsHeader}>
            <ThemedText type="smallBold">Lap</ThemedText>
            <ThemedText type="smallBold">Waktu lap</ThemedText>
            <ThemedText type="smallBold">Total</ThemedText>
          </View>
          {state.laps.length === 0 ? (
            <ThemedText type="small" themeColor="textSecondary">Belum ada lap.</ThemedText>
          ) : (
            state.laps.slice().reverse().map((lap, index) => (
              <View key={`${lap.recordedAtMs}-${index}`} style={styles.lapRow}>
                <ThemedText type="small">#{state.laps.length - index}</ThemedText>
                <ThemedText type="small">{formatStopwatch(lap.lapMs)}</ThemedText>
                <ThemedText type="small">{formatStopwatch(lap.elapsedMs)}</ThemedText>
              </View>
            ))
          )}
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
  actions: { flexDirection: 'row', gap: Spacing.two },
  primaryButton: { flex: 1, backgroundColor: Accent, borderRadius: Radius.control, alignItems: 'center', paddingVertical: Spacing.three },
  primaryText: { color: '#fff', fontWeight: '700' },
  secondaryButton: { borderRadius: Radius.control, paddingHorizontal: Spacing.three, paddingVertical: Spacing.three, backgroundColor: '#00000012', alignItems: 'center' },
  lapsHeader: { flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#8888', paddingBottom: Spacing.one },
  lapRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: Spacing.two },
  error: { color: '#d33', lineHeight: 20 },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 },
});
