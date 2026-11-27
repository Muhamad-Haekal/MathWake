import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { SectionHeader } from '@/components/home/section-header';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

interface TodayStatsProps {
  alarmsRang: number;
  attemptsTotal: number;
  attemptsCorrect: number;
  /** True when the attempts query was denied: accuracy is unknown, not zero. */
  attemptsUnavailable: boolean;
}

/**
 * Compact "today" numbers. Every metric is a literal count from
 * alarm_logs or attempts. When there is no
 * activity yet, values show "-" with one honest note, never zeros
 * dressed up as insight. When attempts access is denied, that is
 * stated instead of shown as zero activity.
 */
export function TodayStats({
  alarmsRang,
  attemptsTotal,
  attemptsCorrect,
  attemptsUnavailable,
}: TodayStatsProps) {
  const hasActivity = alarmsRang > 0 || attemptsTotal > 0;
  const accuracy =
    attemptsTotal > 0 ? `${Math.round((attemptsCorrect / attemptsTotal) * 100)}%` : '-';

  return (
    <View style={styles.section}>
      <SectionHeader title="Hari ini" />
      <View style={styles.grid}>
        <StatTile
          icon={{ ios: 'bell.fill', android: 'notifications', web: 'notifications' }}
          value={hasActivity ? String(alarmsRang) : '-'}
          label="Alarm berbunyi"
        />
        <StatTile
          icon={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }}
          value={accuracy}
          label="Soal benar"
          detail={attemptsTotal > 0 ? `${attemptsCorrect} dari ${attemptsTotal}` : undefined}
        />
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

function StatTile({
  icon,
  value,
  label,
  detail,
}: {
  icon: SymbolViewProps['name'];
  value: string;
  label: string;
  detail?: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={[styles.tile, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}
      accessible
      accessibilityLabel={`${label}: ${value === '-' ? 'belum ada' : value}${detail ? `, ${detail}` : ''}`}>
      <View style={[styles.tileIcon, { backgroundColor: theme.primarySoft }]}>
        <SymbolView name={icon} size={16} tintColor={theme.primaryStrong} />
      </View>
      <ThemedText style={styles.value}>{value}</ThemedText>
      <ThemedText themeColor="textSecondary" style={styles.label}>{label}</ThemedText>
      {detail ? <ThemedText themeColor="textSecondary" style={styles.detail}>{detail}</ThemedText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: Spacing.two },
  grid: { flexDirection: 'row', gap: Spacing.three },
  tile: {
    flex: 1,
    borderRadius: Radius.block,
    borderWidth: 1,
    padding: Spacing.three,
    gap: Spacing.one,
    minHeight: 120,
  },
  tileIcon: { width: 32, height: 32, borderRadius: Radius.control - 2, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.one },
  value: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  label: { fontSize: 14, fontWeight: '600' },
  detail: { fontSize: 13 },
  note: {
    lineHeight: 20,
  },
});
