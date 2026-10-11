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
import { useTheme } from '@/hooks/use-theme';
import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('invalid login credentials') || m.includes('invalid email or password')) {
    return 'Email atau password salah. Periksa kembali dan coba lagi.';
  }
  if (m.includes('email not confirmed') || m.includes('email_not_confirmed')) {
    return 'Email belum dikonfirmasi. Periksa kotak masuk email kamu.';
  }
  if (m.includes('over_email_send_rate_limit') || m.includes('over_request_rate_limit')) {
    const seconds = message.match(/after\s+(\d+)\s+second/i)?.[1];
    return seconds
      ? `Terlalu banyak percobaan. Tunggu ${seconds} detik lalu coba lagi.`
      : 'Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.';
  }
  if (m.includes('too many requests') || m.includes('rate limit')) {
    return 'Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.';
  }
  if (m.includes('network') || m.includes('fetch') || m.includes('failed to fetch')) {
    return 'Tidak dapat terhubung. Periksa koneksi internet kamu.';
  }
  return 'Terjadi kesalahan. Coba lagi nanti.';
}

function validateEmail(email: string): string | null {
  if (!email.trim()) return 'Email tidak boleh kosong.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Format email tidak valid.';
  return null;
}

function validatePassword(password: string): string | null {
  if (!password) return 'Password tidak boleh kosong.';
  if (password.length < 6) return 'Password minimal 6 karakter.';
  return null;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function LoginScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function clearErrors() {
    setEmailError(null);
    setPasswordError(null);
    setFormError(null);
  }

  async function handleLogin() {
    clearErrors();

    const eErr = validateEmail(email);
    const pErr = validatePassword(password);
    if (eErr) setEmailError(eErr);
    if (pErr) setPasswordError(pErr);
    if (eErr || pErr) return;

    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    setLoading(false);

    if (error) {
      console.warn('[MathWake][Login] signInWithPassword error:', {
        code: (error as { code?: string }).code ?? 'no_code',
        status: error.status,
        message: error.message,
      });
      setFormError(friendlyAuthError(error.message));
      return;
    }
    // onAuthStateChange in AuthProvider will fire → Stack.Protected will
    // automatically navigate into (app). No explicit router.replace needed.
  }

  const s = styles(theme, insets);

  return (
    <KeyboardAvoidingView
      style={s.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={s.header}>
          <View style={s.logoMark}>
            <ThemedText style={s.logoEmoji}>⏰</ThemedText>
          </View>
          <ThemedText type="title" style={s.appName}>MathWake</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={s.tagline}>
            Bangun lebih cerdas setiap hari
          </ThemedText>
        </View>

        {/* Card */}
        <View style={[s.card, { backgroundColor: theme.backgroundElement }]}>
          <ThemedText type="subtitle" style={s.cardTitle}>Masuk</ThemedText>

          {/* Email */}
          <View style={s.fieldGroup}>
            <ThemedText type="small" style={s.label}>Email</ThemedText>
            <TextInput
              style={[
                s.input,
                { color: theme.text, borderColor: emailError ? '#EF4444' : theme.backgroundSelected },
              ]}
              placeholder="kamu@email.com"
              placeholderTextColor={theme.textSecondary}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              value={email}
              onChangeText={(v) => { setEmail(v); setEmailError(null); setFormError(null); }}
              onSubmitEditing={handleLogin}
              returnKeyType="next"
              editable={!loading}
            />
            {emailError && (
              <ThemedText type="small" style={s.fieldError}>{emailError}</ThemedText>
            )}
          </View>

          {/* Password */}
          <View style={s.fieldGroup}>
            <ThemedText type="small" style={s.label}>Password</ThemedText>
            <TextInput
              style={[
                s.input,
                { color: theme.text, borderColor: passwordError ? '#EF4444' : theme.backgroundSelected },
              ]}
              placeholder="••••••••"
              placeholderTextColor={theme.textSecondary}
              secureTextEntry
              autoComplete="current-password"
              value={password}
              onChangeText={(v) => { setPassword(v); setPasswordError(null); setFormError(null); }}
              onSubmitEditing={handleLogin}
              returnKeyType="done"
              editable={!loading}
            />
            {passwordError && (
              <ThemedText type="small" style={s.fieldError}>{passwordError}</ThemedText>
            )}
          </View>

          {/* Form-level error */}
          {formError && (
            <View style={s.formErrorBox}>
              <ThemedText type="small" style={s.formErrorText}>{formError}</ThemedText>
            </View>
          )}

          {/* Submit */}
          <Pressable
            style={({ pressed }) => [s.primaryButton, pressed && s.primaryButtonPressed, loading && s.primaryButtonDisabled]}
            onPress={handleLogin}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel="Masuk ke akun">
            {loading
              ? <ActivityIndicator color="#ffffff" />
              : <ThemedText style={s.primaryButtonText}>Masuk</ThemedText>
            }
          </Pressable>
        </View>

        {/* Footer nav */}
        <View style={s.footer}>
          <ThemedText type="small" themeColor="textSecondary">Belum punya akun?</ThemedText>
          <Pressable
            onPress={() => router.push('/auth/register')}
            disabled={loading}
            accessibilityRole="link"
            accessibilityLabel="Buat akun baru">
            <ThemedText type="small" style={s.linkText}>Daftar</ThemedText>
          </Pressable>
        </View>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Styles (factory — depends on current theme + insets)
// ---------------------------------------------------------------------------

function styles(
  theme: ReturnType<typeof useTheme>,
  insets: ReturnType<typeof useSafeAreaInsets>,
) {
  return StyleSheet.create({
    flex: {
      flex: 1,
      backgroundColor: theme.background,
    },
    scroll: {
      flex: 1,
    },
    scrollContent: {
      flexGrow: 1,
      justifyContent: 'center',
      paddingHorizontal: Spacing.four,
      paddingTop: insets.top + Spacing.six,
      paddingBottom: insets.bottom + Spacing.four,
      gap: Spacing.four,
    },
    header: {
      alignItems: 'center',
      gap: Spacing.two,
    },
    logoMark: {
      width: 80,
      height: 80,
      borderRadius: 24,
      backgroundColor: '#208AEF',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Spacing.two,
    },
    logoEmoji: {
      fontSize: 38,
    },
    appName: {
      fontSize: 36,
      fontWeight: '700',
      letterSpacing: -0.5,
    },
    tagline: {
      textAlign: 'center',
    },
    card: {
      borderRadius: 20,
      padding: Spacing.four,
      gap: Spacing.three,
    },
    cardTitle: {
      fontSize: 24,
      marginBottom: Spacing.one,
    },
    fieldGroup: {
      gap: Spacing.one,
    },
    label: {
      fontWeight: '600',
    },
    input: {
      borderWidth: 1.5,
      borderRadius: 12,
      paddingHorizontal: Spacing.three,
      paddingVertical: Platform.OS === 'ios' ? 14 : 10,
      fontSize: 16,
      backgroundColor: theme.background,
    },
    fieldError: {
      color: '#EF4444',
    },
    formErrorBox: {
      backgroundColor: '#FEE2E2',
      borderRadius: 10,
      padding: Spacing.three,
    },
    formErrorText: {
      color: '#B91C1C',
    },
    primaryButton: {
      backgroundColor: '#208AEF',
      borderRadius: 14,
      paddingVertical: 16,
      alignItems: 'center',
      marginTop: Spacing.one,
    },
    primaryButtonPressed: {
      opacity: 0.85,
    },
    primaryButtonDisabled: {
      opacity: 0.6,
    },
    primaryButtonText: {
      color: '#ffffff',
      fontWeight: '700',
      fontSize: 16,
    },
    footer: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: Spacing.one,
      alignItems: 'center',
    },
    linkText: {
      color: '#208AEF',
      fontWeight: '700',
    },
  });
}
