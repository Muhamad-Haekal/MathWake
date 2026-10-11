import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Accent, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  describeAlarmDay,
  describeAlarmSchedule,
  formatCountdown,
  formatTimeID,
  type NextAlarm,
} from '@/lib/home-data';

interface NextAlarmCardProps {
  nextAlarm: NextAlarm | null;
  activeCount: number;
  now: Date;
}

/**
 * The hero block of the dashboard: the single next ringing alarm.
 * Truthful by construction: every value comes from the alarms table.
 * When nothing is scheduled, it says so instead of inventing a time.
 */
export function NextAlarmCard({ nextAlarm, activeCount, now }: NextAlarmCardProps) {
  const theme = useTheme();

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

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.block,
    padding: Spacing.four,
    gap: Spacing.one,
  },
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
