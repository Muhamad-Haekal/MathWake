import { router } from 'expo-router';
import { useState } from 'react';
import { SymbolView } from 'expo-symbols';
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
import { Radius, Spacing } from '@/constants/theme';
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
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [confirmationVisible, setConfirmationVisible] = useState(false);
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
      <ScrollView style={styles.flex} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.centerCard}>
          <ThemedText type="subtitle">Pemulihan password sedang berlangsung</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Selesaikan pemulihan password terlebih dahulu.
          </ThemedText>
        </View>
      </ScrollView>
    );
  }

  if (profileError) {
    return (
      <ScrollView style={styles.flex} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.centerCard}>
          <ThemedText type="subtitle">Profil belum dapat dimuat</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Periksa koneksi internet lalu coba lagi.
          </ThemedText>
          <ActionButton label="Coba lagi" loading={loading} onPress={refreshProfile} disabled={loading} styles={styles} />
        </View>
      </ScrollView>
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
              <View style={styles.passwordContainer}>
                <TextInput
                  style={[styles.input, styles.passwordInput]}
                  placeholder="Password MathWake"
                  placeholderTextColor={theme.textSecondary}
                  secureTextEntry={!passwordVisible}
                  autoComplete="new-password"
                  value={password}
                  onChangeText={(value) => { setPassword(value); setFormError(null); }}
                  editable={!loading}
                />
                <Pressable
                  onPress={() => setPasswordVisible((v) => !v)}
                  disabled={loading}
                  accessibilityRole="button"
                  accessibilityLabel={passwordVisible ? 'Sembunyikan password' : 'Tampilkan password'}
                  style={styles.eyeButton}
                  hitSlop={8}>
                  <SymbolView
                    name={
                      passwordVisible
                        ? { ios: 'eye.slash', android: 'visibility_off', web: 'visibility_off' }
                        : { ios: 'eye', android: 'visibility', web: 'visibility' }
                    }
                    size={20}
                    tintColor={theme.textSecondary}
                  />
                </Pressable>
              </View>
              <View style={styles.passwordContainer}>
                <TextInput
                  style={[styles.input, styles.passwordInput]}
                  placeholder="Konfirmasi password MathWake"
                  placeholderTextColor={theme.textSecondary}
                  secureTextEntry={!confirmationVisible}
                  autoComplete="new-password"
                  value={confirmation}
                  onChangeText={(value) => { setConfirmation(value); setFormError(null); }}
                  editable={!loading}
                />
                <Pressable
                  onPress={() => setConfirmationVisible((v) => !v)}
                  disabled={loading}
                  accessibilityRole="button"
                  accessibilityLabel={confirmationVisible ? 'Sembunyikan konfirmasi password' : 'Tampilkan konfirmasi password'}
                  style={styles.eyeButton}
                  hitSlop={8}>
                  <SymbolView
                    name={
                      confirmationVisible
                        ? { ios: 'eye.slash', android: 'visibility_off', web: 'visibility_off' }
                        : { ios: 'eye', android: 'visibility', web: 'visibility' }
                    }
                    size={20}
                    tintColor={theme.textSecondary}
                  />
                </Pressable>
              </View>
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
    <Pressable
      style={({ pressed }) => [styles.button, (pressed || disabled) && { opacity: disabled ? 0.5 : 0.85 }]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: loading }}>
      {loading ? <ActivityIndicator color={styles.buttonText.color} /> : <ThemedText style={styles.buttonText}>{label}</ThemedText>}
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
      borderRadius: Radius.block,
      backgroundColor: theme.backgroundElement,
    },
    centerCard: {
      margin: Spacing.four,
      padding: Spacing.four,
      width: '100%',
      maxWidth: 440,
      alignSelf: 'center',
      gap: Spacing.three,
      borderRadius: Radius.block,
      backgroundColor: theme.backgroundElement,
    },
    title: { fontSize: 24 },
    input: {
      minHeight: 48,
      borderWidth: 1.5,
      borderColor: theme.border,
      borderRadius: Radius.control,
      paddingHorizontal: Spacing.three,
      paddingVertical: Platform.OS === 'ios' ? 14 : 10,
      fontSize: 16,
      color: theme.text,
      backgroundColor: theme.background,
    },
    passwordContainer: {
      position: 'relative',
      justifyContent: 'center',
    },
    passwordInput: {
      paddingRight: 48,
    },
    eyeButton: {
      position: 'absolute',
      right: Spacing.two,
      height: '100%',
      justifyContent: 'center',
      alignItems: 'center',
      minWidth: 44,
      minHeight: 44,
    },
    button: {
      backgroundColor: theme.primary,
      borderRadius: Radius.control,
      minHeight: 52,
      justifyContent: 'center',
      paddingVertical: 15,
      alignItems: 'center',
    },
    buttonText: { color: theme.onPrimary, fontWeight: '700', fontSize: 16 },
    error: { color: theme.danger },
  });
}
