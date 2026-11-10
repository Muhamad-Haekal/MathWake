import { router, Stack } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useAuth } from '@/contexts/auth-context';

export default function AuthCallbackScreen() {
  const { recoveryActive, user } = useAuth();
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <ThemedText type="subtitle">Tautan belum dapat diproses</ThemedText>
      <ThemedText type="small" style={styles.message}>
        Tautan mungkin kedaluwarsa atau tidak valid. Kamu dapat memulai pemulihan password lagi.
      </ThemedText>
      {recoveryActive && (
        <Pressable style={styles.button} onPress={() => router.replace('/password-recovery')} accessibilityRole="button">
          <ThemedText style={styles.buttonText}>Lanjutkan pemulihan</ThemedText>
        </Pressable>
      )}
      <Pressable style={styles.button} onPress={() => router.replace('/password-recovery')} accessibilityRole="button">
        <ThemedText style={styles.buttonText}>Minta tautan baru</ThemedText>
      </Pressable>
      {!user && (
        <Pressable onPress={() => router.replace('/auth/login')} accessibilityRole="link">
          <ThemedText style={styles.link}>Kembali ke login</ThemedText>
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
    padding: 24,
    gap: 16,
  },
  message: { textAlign: 'center' },
  button: { width: '100%', alignItems: 'center', backgroundColor: '#208AEF', borderRadius: 14, padding: 15 },
  buttonText: { color: '#ffffff', fontWeight: '700' },
  link: { color: '#208AEF', fontWeight: '600' },
});
