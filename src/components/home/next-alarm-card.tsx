import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Accent, Danger, Radius, Spacing } from '@/constants/theme';
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
  activeCount: number;
  now: Date;
  /** Alarm that has really fired and whose challenge is unsolved. Independent of schedules. */
  active?: ActiveAlarmState | null;
  /** Schedule row of the active alarm when it still exists and is enabled. */
  activeAlarmRow?: NextAlarm['alarm'] | null;
  openingChallenge?: boolean;
  challengeError?: string | null;
  onContinueActiveChallenge: () => void;
}

/**
 * The hero block of the dashboard: the single next ringing alarm.
 * Truthful by construction: every value comes from the alarms table.
 * When nothing is scheduled, it says so instead of inventing a time.
 * A ringing alarm is shown separately and only from live/session evidence.
 */
export function NextAlarmCard({ nextAlarm, activeCount, now, active = null, activeAlarmRow = null, openingChallenge = false, challengeError = null, onContinueActiveChallenge }: NextAlarmCardProps) {
  const theme = useTheme();

  if (active) {
    return (
      <View style={styles.stack}>
        <ActiveAlarmCard active={active} alarm={activeAlarmRow} openingChallenge={openingChallenge} challengeError={challengeError} onContinue={onContinueActiveChallenge} />
        {nextAlarm ? <NextAlarmCard nextAlarm={nextAlarm} activeCount={activeCount} now={now} openingChallenge={openingChallenge} challengeError={challengeError} onContinueActiveChallenge={onContinueActiveChallenge} /> : null}
      </View>
    );
  }

  if (!nextAlarm) {
    return (
      <View style={[styles.empty, { backgroundColor: theme.backgroundElement }]}>
        <ThemedText type="smallBold" style={styles.emptyTitle}>
          Belum ada alarm aktif
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.emptyBody}>
          Nyalakan atau tambah alarm supaya MathWake membangunkanmu tepat waktu.
        </ThemedText>
      </View>
    );
  }

  const { alarm, at } = nextAlarm;
  const meta: string[] = [describeAlarmSchedule(alarm)];
  if (alarm.difficulty) meta.push(`Level ${alarm.difficulty}`);
  if (typeof alarm.question_count === 'number') {
    meta.push(`${alarm.question_count} soal`);
  }
  const extra = activeCount > 1 ? `+${activeCount - 1} alarm lain` : undefined;

  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
      <View style={styles.topRow}>
        <ThemedText type="small" themeColor="textSecondary">
          Alarm berikutnya
        </ThemedText>
        <View style={styles.countdownChip}>
          <ThemedText type="small" style={styles.countdownText}>
            {formatCountdown(at, now)}
          </ThemedText>
        </View>
      </View>

      <ThemedText style={[styles.time, { color: Accent }]}>
        {formatTimeID(alarm.time)}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {describeAlarmDay(at, now)}
        {extra ? `  ${extra}` : ''}
      </ThemedText>

       <View style={styles.metaRow}>
         <ThemedText type="small" themeColor="textSecondary">
           {meta.join('   ')}
         </ThemedText>
       </View>
     </View>
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
  return (
    <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
      <ThemedText type="small" themeColor="textSecondary">
        {active.verified ? 'Alarm sedang berbunyi' : 'Tantangan alarm belum selesai'}
      </ThemedText>
      {alarm ? <ThemedText style={[styles.time, { color: Accent }]}>{formatTimeID(alarm.time)}</ThemedText> : null}
      <ThemedText type="small" themeColor="textSecondary">
        Notifikasi tidak diperlukan untuk melanjutkan tantangan.
      </ThemedText>
      {challengeError ? <ThemedText type="small" style={styles.challengeError}>{challengeError}</ThemedText> : null}
      <Pressable
        onPress={onContinue}
        disabled={openingChallenge}
        accessibilityRole="button"
        accessibilityLabel="Kerjakan soal alarm yang sedang berbunyi"
        accessibilityState={{ disabled: openingChallenge, busy: openingChallenge }}
        style={styles.challengeButton}>
        <ThemedText type="small" style={styles.challengeButtonText}>{openingChallenge ? 'Membuka...' : 'Kerjakan'}</ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.block,
    padding: Spacing.four,
    gap: Spacing.one,
  },
  stack: { gap: Spacing.four },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  countdownChip: {
    backgroundColor: Accent,
    borderRadius: Radius.chip,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  countdownText: {
    color: '#ffffff',
    fontWeight: '700',
  },
  time: {
    fontSize: 56,
    lineHeight: 60,
    fontWeight: '700',
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
  metaRow: {
    marginTop: Spacing.one,
  },
  challengeButton: {
    marginTop: Spacing.two,
    borderRadius: Radius.control,
    backgroundColor: Accent,
    paddingVertical: Spacing.two,
    alignItems: 'center',
  },
  challengeButtonText: {
    color: '#ffffff',
    fontWeight: '700',
  },
  challengeError: {
    color: Danger,
  },
  empty: {
    borderRadius: Radius.block,
    padding: Spacing.four,
    gap: Spacing.one,
  },
  emptyTitle: {
    fontSize: 17,
    lineHeight: 24,
  },
  emptyBody: {
    lineHeight: 20,
  },
});
