import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { SectionHeader } from '@/components/home/section-header';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

interface TodayStatsProps {
  alarmsRang: number;
  attemptsTotal: number;
  attemptsCorrect: number;
  routinesDone: number;
  /** True when the attempts query was denied: accuracy is unknown, not zero. */
  attemptsUnavailable: boolean;
}

/**
 * Compact "today" numbers. Every metric is a literal count from
 * alarm_logs, attempts, or routine_completions. When there is no
 * activity yet, values show "-" with one honest note, never zeros
 * dressed up as insight. When attempts access is denied, that is
 * stated instead of shown as zero activity.
 */
export function TodayStats({
  alarmsRang,
  attemptsTotal,
  attemptsCorrect,
  routinesDone,
  attemptsUnavailable,
}: TodayStatsProps) {
  const theme = useTheme();
  const hasActivity = alarmsRang > 0 || attemptsTotal > 0 || routinesDone > 0;
  const accuracy =
    attemptsTotal > 0 ? `${Math.round((attemptsCorrect / attemptsTotal) * 100)}%` : '-';

  return (
    <View>
      <SectionHeader title="Hari ini" />
      <View style={styles.grid}>
        <View style={styles.cell}>
          <ThemedText style={styles.value}>{hasActivity ? String(alarmsRang) : '-'}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Alarm berbunyi
          </ThemedText>
        </View>
        <View style={[styles.cell, styles.midCell, { borderLeftColor: theme.backgroundSelected, borderRightColor: theme.backgroundSelected }]}>
          <ThemedText style={styles.value}>{accuracy}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Soal benar
          </ThemedText>
          {attemptsTotal > 0 ? (
            <ThemedText type="small" themeColor="textSecondary">
              {attemptsCorrect} dari {attemptsTotal}
            </ThemedText>
          ) : null}
        </View>
        <View style={styles.cell}>
          <ThemedText style={styles.value}>{hasActivity ? String(routinesDone) : '-'}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Rutinitas selesai
          </ThemedText>
        </View>
      </View>
      {!hasActivity && !attemptsUnavailable ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
          Belum ada aktivitas hari ini. Data muncul setelah alarm berbunyi.
        </ThemedText>
      ) : null}
      {attemptsUnavailable ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
          Statistik soal tidak dapat dimuat saat ini.
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  cell: {
    flex: 1,
    alignItems: 'center',
    gap: Spacing.half,
    paddingVertical: Spacing.one,
  },
  midCell: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  value: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  note: {
    marginTop: Spacing.two,
    lineHeight: 20,
  },
});
