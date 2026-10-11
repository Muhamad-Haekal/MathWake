import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { SectionHeader } from '@/components/home/section-header';
import { Accent, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { RoutineProgress } from '@/lib/home-data';

interface RoutineSummaryProps {
  routine: RoutineProgress[];
  done: number;
  total: number;
}

/**
 * Morning-routine summary from routine_items plus today's
 * routine_completions. Progress is per-item done/target counts.
 */
export function RoutineSummary({ routine, done, total }: RoutineSummaryProps) {
  const theme = useTheme();

  if (total === 0) {
    return (
      <View>
        <SectionHeader title="Rutinitas pagi" />
        <ThemedText type="small" themeColor="textSecondary" style={styles.emptyBody}>
          Belum ada rutinitas. Tambahkan rutinitas pagimu agar progresnya tercatat di sini.
        </ThemedText>
      </View>
    );
  }

  return (
    <View>
      <SectionHeader
        title="Rutinitas pagi"
        aside={`${done} dari ${total} selesai`}
      />
      <View>
        {routine.map(({ item, done: itemDone, target, finished }, index) => (
          <View
            key={item.id}
            style={[
              styles.row,
              index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.backgroundSelected },
            ]}>
            <View style={styles.labelWrap}>
              <ThemedText
                type="small"
                style={[styles.label, finished && { color: theme.textSecondary }]}>
                {item.label}
              </ThemedText>
            </View>
            <ThemedText
              type="small"
              style={finished ? styles.finishedMark : { color: theme.textSecondary }}>
              {finished ? 'Selesai' : `${itemDone}/${target}`}
            </ThemedText>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.two + Spacing.half,
    gap: Spacing.three,
  },
  labelWrap: {
    flex: 1,
  },
  label: {
    fontWeight: '600',
  },
  finishedMark: {
    color: Accent,
    fontWeight: '700',
  },
  emptyBody: {
    lineHeight: 20,
  },
});
