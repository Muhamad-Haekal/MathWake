import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

interface SectionHeaderProps {
  title: string;
  aside?: string;
}

/** Plain two-part section header. No eyebrow micro-labels, no decoration. */
export function SectionHeader({ title, aside }: SectionHeaderProps) {
  return (
    <View style={styles.row}>
      <ThemedText type="smallBold" style={styles.title}>
        {title}
      </ThemedText>
      {aside ? (
        <ThemedText type="small" themeColor="textSecondary">
          {aside}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: Spacing.two,
  },
  title: {
    fontSize: 17,
    lineHeight: 24,
  },
});
