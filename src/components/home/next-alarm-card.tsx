import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { androidRipple } from '@/components/ui/android-ripple';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  describeAlarmDay,
  describeAlarmSchedule,
  formatCountdown,
  formatTimeID,
  type NextAlarm,
} from '@/lib/home-data';
import type { ActiveAlarmState } from '@/lib/alarm-active-state';

interface NextAlarmCardProps {
  nextAlarm: NextAlarm | null;
  snoozedAlarm?: { alarm: NextAlarm['alarm']; triggerAtMs: number; snoozeMinutes: number } | null;
  activeCount: number;
  now: Date;
  /** Alarm that has really fired and whose challenge is unsolved. Independent of schedules. */
  active?: ActiveAlarmState | null;
  /** Schedule row of the active alarm when it still exists and is enabled. */
  activeAlarmRow?: NextAlarm['alarm'] | null;
  openingChallenge?: boolean;
  challengeError?: string | null;
  onContinueActiveChallenge: () => void;
  /** Opens the alarm list (used by the empty state and "manage" link). */
  onOpenAlarms?: () => void;
}

/**
 * The hero block of the dashboard: the single next ringing alarm.
 * Truthful by construction: every value comes from the alarms table.
 * When nothing is scheduled, it says so instead of inventing a time.
 * A ringing alarm is shown separately and only from live/session evidence.
 */
export function NextAlarmCard({ nextAlarm, snoozedAlarm = null, activeCount, now, active = null, activeAlarmRow = null, openingChallenge = false, challengeError = null, onContinueActiveChallenge, onOpenAlarms }: NextAlarmCardProps) {
  const theme = useTheme();

  if (active) {
    return (
      <View style={styles.stack}>
        <ActiveAlarmCard active={active} alarm={activeAlarmRow} openingChallenge={openingChallenge} challengeError={challengeError} onContinue={onContinueActiveChallenge} />
        {snoozedAlarm ? <SnoozedAlarmCard snoozed={snoozedAlarm} now={now} onOpenAlarms={onOpenAlarms} /> : null}
        {nextAlarm ? <NextAlarmCard nextAlarm={nextAlarm} activeCount={activeCount} now={now} openingChallenge={openingChallenge} challengeError={challengeError} onContinueActiveChallenge={onContinueActiveChallenge} onOpenAlarms={onOpenAlarms} /> : null}
      </View>
    );
  }

  if (snoozedAlarm) {
    return (
      <View style={styles.stack}>
        <SnoozedAlarmCard snoozed={snoozedAlarm} now={now} onOpenAlarms={onOpenAlarms} />
        {nextAlarm ? <NextAlarmCard nextAlarm={nextAlarm} activeCount={activeCount} now={now} onContinueActiveChallenge={onContinueActiveChallenge} onOpenAlarms={onOpenAlarms} /> : null}
      </View>
    );
  }

  if (!nextAlarm) {
    return (
      <View style={[styles.card, styles.emptyCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
        <View style={[styles.iconBadge, { backgroundColor: theme.primarySoft }]}>
          <SymbolView name={{ ios: 'alarm', android: 'alarm_off', web: 'alarm_off' }} size={26} tintColor={theme.primaryStrong} />
        </View>
        <ThemedText style={styles.emptyTitle} accessibilityRole="header">
          Belum ada alarm aktif
        </ThemedText>
        <ThemedText themeColor="textSecondary" style={styles.emptyBody}>
          Nyalakan atau tambah alarm supaya MathWake membangunkanmu tepat waktu.
        </ThemedText>
        {onOpenAlarms ? (
          <Pressable
            onPress={onOpenAlarms}
            accessibilityRole="button"
            accessibilityLabel="Atur alarm"
            android_ripple={androidRipple(theme.onPrimary)}
            style={({ pressed }) => [styles.primaryButton, { backgroundColor: theme.primary }, pressed && styles.pressed]}>
            <SymbolView name={{ ios: 'plus', android: 'add', web: 'add' }} size={18} tintColor={theme.onPrimary} />
            <ThemedText style={[styles.primaryButtonText, { color: theme.onPrimary }]}>Atur alarm</ThemedText>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const { alarm, at } = nextAlarm;
  const title = typeof alarm.title === 'string' && alarm.title.trim() ? alarm.title.trim() : null;
  const chips: string[] = [describeAlarmSchedule(alarm)];
  if (alarm.difficulty) chips.push(capitalize(alarm.difficulty));
  if (typeof alarm.question_count === 'number') chips.push(`${alarm.question_count} soal`);
  const others = activeCount - 1;

  return (
    <Pressable
      onPress={onOpenAlarms}
      disabled={!onOpenAlarms}
      accessibilityRole={onOpenAlarms ? 'button' : undefined}
      accessibilityLabel={`Alarm berikutnya ${describeAlarmDay(at, now)} pukul ${formatTimeID(alarm.time)}, ${formatCountdown(at, now)}`}
      accessibilityHint={onOpenAlarms ? 'Buka daftar alarm' : undefined}
      android_ripple={androidRipple(theme.primarySoft)}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
        pressed && styles.cardPressed,
      ]}>
      <View style={styles.topRow}>
        <View style={styles.labelRow}>
          <SymbolView name={{ ios: 'alarm.fill', android: 'alarm', web: 'alarm' }} size={16} tintColor={theme.primaryStrong} />
          <ThemedText style={[styles.eyebrow, { color: theme.primaryStrong }]}>ALARM BERIKUTNYA</ThemedText>
        </View>
        {onOpenAlarms ? <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={16} tintColor={theme.textSecondary} /> : null}
      </View>

      <View style={styles.timeRow}>
        <ThemedText style={[styles.time, { color: theme.text }]}>{formatTimeID(alarm.time)}</ThemedText>
        <View style={styles.timeMeta}>
          <ThemedText style={styles.dayText}>{describeAlarmDay(at, now)}</ThemedText>
          <ThemedText themeColor="textSecondary" style={styles.countdown}>{formatCountdown(at, now)}</ThemedText>
        </View>
      </View>
      {title ? <ThemedText style={styles.alarmTitle}>{title}</ThemedText> : null}

      <View style={styles.chipRow}>
        {chips.map((chip) => (
          <View key={chip} style={[styles.chip, { backgroundColor: theme.background, borderColor: theme.border }]}>
            <ThemedText style={styles.chipText} themeColor="textSecondary">{chip}</ThemedText>
          </View>
        ))}
      </View>
      {others > 0 ? (
        <ThemedText themeColor="textSecondary" style={styles.othersText}>
          +{others} alarm aktif lainnya
        </ThemedText>
      ) : null}
    </Pressable>
  );
}

function SnoozedAlarmCard({
  snoozed,
  now,
  onOpenAlarms,
}: {
  snoozed: { alarm: NextAlarm['alarm']; triggerAtMs: number; snoozeMinutes: number };
  now: Date;
  onOpenAlarms?: () => void;
}) {
  const theme = useTheme();
  const alarmTitle = typeof snoozed.alarm.title === 'string' && snoozed.alarm.title.trim()
    ? snoozed.alarm.title.trim()
    : 'Alarm';
  const timeLeft = formatCountdown(new Date(snoozed.triggerAtMs), now);
  return (
    <Pressable
      onPress={onOpenAlarms}
      disabled={!onOpenAlarms}
      accessibilityRole={onOpenAlarms ? 'button' : undefined}
      accessibilityLabel={`${alarmTitle} aktif, ditunda ${snoozed.snoozeMinutes} menit, berbunyi kembali ${timeLeft}`}
      android_ripple={androidRipple(theme.primarySoft)}
      style={({ pressed }) => [styles.card, styles.snoozedCard, { backgroundColor: theme.backgroundElement, borderColor: theme.primary }, pressed && styles.cardPressed]}>
      <View style={styles.topRow}>
        <View style={styles.labelRow}>
          <SymbolView name={{ ios: 'alarm.fill', android: 'alarm', web: 'alarm' }} size={17} tintColor={theme.primaryStrong} />
          <ThemedText style={[styles.eyebrow, { color: theme.primaryStrong }]}>ALARM AKTIF · DITUNDA</ThemedText>
        </View>
        {onOpenAlarms ? <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={16} tintColor={theme.textSecondary} /> : null}
      </View>
      <View style={styles.timeRow}>
        <ThemedText style={[styles.time, { color: theme.text }]}>{formatTimeID(snoozed.alarm.time)}</ThemedText>
        <View style={styles.timeMeta}>
          <ThemedText style={styles.dayText}>{timeLeft}</ThemedText>
          <ThemedText themeColor="textSecondary" style={styles.countdown}>Snooze {snoozed.snoozeMinutes} menit</ThemedText>
        </View>
      </View>
      <ThemedText style={styles.alarmTitle}>{alarmTitle}</ThemedText>
      <ThemedText themeColor="textSecondary" style={styles.activeBody}>Alarm tetap aktif dan akan berbunyi kembali {timeLeft}.</ThemedText>
    </Pressable>
  );
}

export function ActiveAlarmCard({
  active,
  alarm,
  openingChallenge = false,
  challengeError = null,
  onContinue,
}: {
  active: ActiveAlarmState;
  alarm: NextAlarm['alarm'] | null;
  openingChallenge?: boolean;
  challengeError?: string | null;
  onContinue: () => void;
}) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  return (
    <Animated.View
      entering={reduceMotion ? undefined : FadeIn.duration(200)}
      style={[styles.card, styles.activeCard, { backgroundColor: theme.primarySoft, borderColor: theme.primary }]}
      accessibilityLiveRegion="polite">
      <View style={styles.labelRow}>
        <View style={[styles.liveDot, { backgroundColor: theme.primary }]} />
        <ThemedText style={[styles.eyebrow, { color: theme.primaryStrong }]}>
          {active.verified ? 'ALARM SEDANG BERBUNYI' : 'TANTANGAN BELUM SELESAI'}
        </ThemedText>
      </View>
      {alarm ? <ThemedText style={[styles.time, { color: theme.text }]}>{formatTimeID(alarm.time)}</ThemedText> : null}
      <ThemedText themeColor="textSecondary" style={styles.activeBody}>
        Selesaikan soal untuk mematikan alarm. Notifikasi tidak diperlukan untuk melanjutkan.
      </ThemedText>
      {challengeError ? (
        <View style={[styles.errorRow, { backgroundColor: theme.dangerSoft }]} accessibilityRole="alert">
          <SymbolView name={{ ios: 'exclamationmark.circle.fill', android: 'error', web: 'error' }} size={16} tintColor={theme.danger} />
          <ThemedText style={[styles.errorText, { color: theme.danger }]}>{challengeError}</ThemedText>
        </View>
      ) : null}
      <Pressable
        onPress={onContinue}
        disabled={openingChallenge}
        accessibilityRole="button"
        accessibilityLabel="Kerjakan soal alarm yang sedang berbunyi"
        accessibilityState={{ disabled: openingChallenge, busy: openingChallenge }}
        android_ripple={androidRipple(theme.onPrimary)}
        style={({ pressed }) => [styles.primaryButton, { backgroundColor: theme.primary }, (pressed || openingChallenge) && styles.pressed]}>
        <SymbolView name={{ ios: 'function', android: 'calculate', web: 'calculate' }} size={18} tintColor={theme.onPrimary} />
        <ThemedText style={[styles.primaryButtonText, { color: theme.onPrimary }]}>
          {openingChallenge ? 'Membuka...' : 'Kerjakan soal'}
        </ThemedText>
      </Pressable>
    </Animated.View>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const styles = StyleSheet.create({
  stack: { gap: Spacing.three },
  card: {
    borderRadius: Radius.block + 4,
    borderWidth: 1,
    padding: Spacing.four,
    gap: Spacing.two,
  },
  cardPressed: { opacity: 0.92, transform: [{ scale: 0.99 }] },
  activeCard: { borderWidth: 1.5, gap: Spacing.three },
  snoozedCard: { borderWidth: 1.5, gap: Spacing.three },
  emptyCard: { alignItems: 'flex-start', gap: Spacing.three },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  eyebrow: { fontSize: 12, fontWeight: '800', letterSpacing: 0.9 },
  liveDot: { width: 10, height: 10, borderRadius: 5 },
  timeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.three, flexWrap: 'wrap' },
  time: {
    fontSize: 64,
    lineHeight: 70,
    fontWeight: '800',
    letterSpacing: -1.5,
    fontVariant: ['tabular-nums'],
  },
  timeMeta: { paddingBottom: Spacing.two, gap: 2, flexShrink: 1 },
  dayText: { fontSize: 17, fontWeight: '700' },
  countdown: { fontSize: 14, fontWeight: '600' },
  alarmTitle: { fontSize: 16, fontWeight: '600' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two, marginTop: Spacing.one },
  chip: { borderRadius: Radius.chip, borderWidth: 1, paddingHorizontal: Spacing.three, paddingVertical: Spacing.one },
  chipText: { fontSize: 13, fontWeight: '600' },
  othersText: { fontSize: 13, marginTop: Spacing.one },
  activeBody: { fontSize: 15, lineHeight: 22 },
  iconBadge: { width: 52, height: 52, borderRadius: Radius.block, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  emptyBody: { fontSize: 15, lineHeight: 22 },
  primaryButton: {
    alignSelf: 'stretch',
    minHeight: 52,
    borderRadius: Radius.control,
    flexDirection: 'row',
    gap: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
  },
  primaryButtonText: { fontSize: 16, fontWeight: '700' },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, padding: Spacing.three, borderRadius: Radius.control },
  errorText: { flex: 1, fontSize: 14, lineHeight: 20, fontWeight: '600' },
  pressed: { opacity: 0.85 },
});
