import { router, Stack } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/auth-context';
import { useTheme } from '@/hooks/use-theme';

export default function AuthCallbackScreen() {
  const { recoveryActive, user } = useAuth();
  const theme = useTheme();
  const primary = ({ pressed }: { pressed: boolean }) => [
    styles.button,
    { backgroundColor: theme.primary },
    pressed && styles.pressed,
  ];
  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ThemedText type="subtitle" style={styles.message}>Tautan belum dapat diproses</ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.message}>
        Tautan mungkin kedaluwarsa atau tidak valid. Kamu dapat memulai pemulihan password lagi.
      </ThemedText>
      {recoveryActive && (
        <Pressable style={primary} onPress={() => router.replace('/password-recovery')} accessibilityRole="button">
          <ThemedText style={[styles.buttonText, { color: theme.onPrimary }]}>Lanjutkan pemulihan</ThemedText>
        </Pressable>
      )}
      <Pressable style={primary} onPress={() => router.replace('/password-recovery')} accessibilityRole="button">
        <ThemedText style={[styles.buttonText, { color: theme.onPrimary }]}>Minta tautan baru</ThemedText>
      </Pressable>
      {!user && (
        <Pressable onPress={() => router.replace('/auth/login')} accessibilityRole="link" hitSlop={12}>
          <ThemedText style={[styles.link, { color: theme.primaryStrong }]}>Kembali ke login</ThemedText>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.four,
    gap: Spacing.three,
  },
  message: { textAlign: 'center' },
  button: {
    width: '100%',
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.control,
    padding: 15,
  },
  pressed: { opacity: 0.85 },
  buttonText: { fontWeight: '700', fontSize: 16 },
  link: { fontWeight: '600' },
});
