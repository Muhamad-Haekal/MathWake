import { router } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/auth-context';
import { useTheme } from '@/hooks/use-theme';
import { completeMyOnboarding, isGoogleUser } from '@/lib/profile';
import { supabase } from '@/lib/supabase';

function validateDisplayName(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return 'Nama tampilan tidak boleh kosong.';
  if (normalized.length > 80) return 'Nama tampilan maksimal 80 karakter.';
  return null;
}

function validatePassword(value: string, confirmation: string): string | null {
  if (!value) return 'Password MathWake tidak boleh kosong.';
  if (value.length < 6) return 'Password MathWake minimal 6 karakter.';
  if (value !== confirmation) return 'Konfirmasi password tidak cocok.';
  return null;
}

export default function OnboardingScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const {
    user,
    profile,
    profileError,
    refreshProfile,
    recoveryActive,
  } = useAuth();
  const [displayName, setDisplayName] = useState(profile?.display_name ?? '');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const googleOnboarding = isGoogleUser(user);
  const styles = makeStyles(theme, insets);

  async function submit() {
    if (loading) return;
    setFormError(null);

    const nameError = validateDisplayName(displayName);
    const passwordError = googleOnboarding ? validatePassword(password, confirmation) : null;
    if (nameError || passwordError) {
      setFormError(nameError ?? passwordError);
      return;
    }

    setLoading(true);
    try {
      if (googleOnboarding) {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) {
          setFormError('Password MathWake gagal dibuat. Coba lagi nanti.');
          return;
        }
      }

      const result = await completeMyOnboarding(displayName);
      if (result.error) {
        setFormError('Profil belum dapat diselesaikan. Periksa koneksi lalu coba lagi.');
        return;
      }

      await refreshProfile();
      router.replace('/');
    } catch {
      setFormError('Onboarding belum dapat diselesaikan. Coba lagi nanti.');
    } finally {
      setLoading(false);
    }
  }

  if (recoveryActive) {
    return (
      <View style={styles.flex}>
        <View style={styles.centerCard}>
          <ThemedText type="subtitle">Pemulihan password sedang berlangsung</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Selesaikan pemulihan password terlebih dahulu.
          </ThemedText>
        </View>
      </View>
    );
  }

  if (profileError) {
    return (
      <View style={styles.flex}>
        <View style={styles.centerCard}>
          <ThemedText type="subtitle">Profil belum dapat dimuat</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Periksa koneksi internet lalu coba lagi.
          </ThemedText>
          <ActionButton label="Coba lagi" loading={loading} onPress={refreshProfile} disabled={loading} styles={styles} />
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <ThemedText type="subtitle" style={styles.title}>Lengkapi akun MathWake</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {googleOnboarding
              ? 'Buat password khusus MathWake dan isi nama tampilan kamu.'
              : 'Isi nama tampilan kamu sebelum melanjutkan ke Dashboard.'}
          </ThemedText>

          {googleOnboarding && (
            <>
              <TextInput
                style={styles.input}
                placeholder="Password MathWake"
                placeholderTextColor={theme.textSecondary}
                secureTextEntry
                autoComplete="new-password"
                value={password}
                onChangeText={(value) => { setPassword(value); setFormError(null); }}
                editable={!loading}
              />
              <TextInput
                style={styles.input}
                placeholder="Konfirmasi password MathWake"
                placeholderTextColor={theme.textSecondary}
                secureTextEntry
                autoComplete="new-password"
                value={confirmation}
                onChangeText={(value) => { setConfirmation(value); setFormError(null); }}
                editable={!loading}
              />
            </>
          )}

          <TextInput
            style={styles.input}
            placeholder="Nama tampilan"
            placeholderTextColor={theme.textSecondary}
            autoCapitalize="words"
            value={displayName}
            onChangeText={(value) => { setDisplayName(value); setFormError(null); }}
            editable={!loading}
          />

          {formError && <ThemedText type="small" style={styles.error}>{formError}</ThemedText>}
          <ActionButton label="Lanjut ke Dashboard" loading={loading} onPress={submit} disabled={loading} styles={styles} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ActionButton({
  label,
  loading,
  onPress,
  disabled,
  styles,
}: {
  label: string;
  loading: boolean;
  onPress: () => void;
  disabled: boolean;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable style={styles.button} onPress={onPress} disabled={disabled} accessibilityRole="button">
      {loading ? <ActivityIndicator color="#ffffff" /> : <ThemedText style={styles.buttonText}>{label}</ThemedText>}
    </Pressable>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>, insets: ReturnType<typeof useSafeAreaInsets>) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: theme.background },
    content: {
      flexGrow: 1,
      justifyContent: 'center',
      padding: Spacing.four,
      paddingTop: insets.top + Spacing.four,
      paddingBottom: insets.bottom + Spacing.four,
    },
    card: {
      gap: Spacing.three,
      padding: Spacing.four,
      borderRadius: 20,
      backgroundColor: theme.backgroundElement,
    },
    centerCard: {
      margin: Spacing.four,
      padding: Spacing.four,
      gap: Spacing.three,
      borderRadius: 20,
      backgroundColor: theme.backgroundElement,
    },
    title: { fontSize: 24 },
    input: {
      borderWidth: 1.5,
      borderColor: theme.backgroundSelected,
      borderRadius: 12,
      paddingHorizontal: Spacing.three,
      paddingVertical: Platform.OS === 'ios' ? 14 : 10,
      fontSize: 16,
      color: theme.text,
      backgroundColor: theme.background,
    },
    button: {
      backgroundColor: '#208AEF',
      borderRadius: 14,
      paddingVertical: 15,
      alignItems: 'center',
    },
    buttonText: { color: '#ffffff', fontWeight: '700' },
    error: { color: '#B91C1C' },
  });
}
