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
  if (
    m.includes('user already registered') ||
    m.includes('already been registered') ||
    m.includes('user_already_exists') ||
    m.includes('email_exists')
  ) {
    return 'Email ini sudah terdaftar. Coba masuk atau gunakan email lain.';
  }
  if (m.includes('password should be at least') || m.includes('weak_password')) {
    return 'Password terlalu pendek atau terlalu lemah. Gunakan minimal 6 karakter.';
  }
  if (
    m.includes('invalid email') ||
    m.includes('email_address_invalid') ||
    m.includes('validation_failed')
  ) {
    return 'Format email tidak valid.';
  }
  if (m.includes('email_address_not_authorized')) {
    return 'Email ini tidak dapat digunakan. Coba dengan email lain.';
  }
  if (m.includes('signup_disabled') || m.includes('email_provider_disabled')) {
    return 'Pendaftaran akun baru sedang tidak tersedia.';
  }
  if (m.includes('over_email_send_rate_limit') || m.includes('over_request_rate_limit')) {
    // Supabase includes the wait time in the message, e.g. "after 32 seconds".
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
  // unexpected_failure and database errors → generic message to user,
  // but the raw message is logged separately before this function is called.
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

function validateConfirm(password: string, confirm: string): string | null {
  if (!confirm) return 'Konfirmasi password tidak boleh kosong.';
  if (password !== confirm) return 'Password tidak cocok.';
  return null;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function RegisterScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  // null = not submitted yet; true = need confirmation; false = session active
  const [pendingConfirmation, setPendingConfirmation] = useState(false);

  function clearErrors() {
    setEmailError(null);
    setPasswordError(null);
    setConfirmError(null);
    setFormError(null);
  }

  async function handleRegister() {
    clearErrors();

    const eErr = validateEmail(email);
    const pErr = validatePassword(password);
    const cErr = validateConfirm(password, confirm);
    if (eErr) setEmailError(eErr);
    if (pErr) setPasswordError(pErr);
    if (cErr) setConfirmError(cErr);
    if (eErr || pErr || cErr) return;

    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
    });
    setLoading(false);

    if (error) {
      // Log the raw error safely for development diagnostics.
      // Never logs password, tokens, or personal data beyond email domain.
      console.warn('[MathWake][Register] signUp error:', {
        code: (error as { code?: string }).code ?? 'no_code',
        status: error.status,
        message: error.message,
      });
      setFormError(friendlyAuthError(error.message));
      return;
    }

    // Log success details (no sensitive fields).
    console.info('[MathWake][Register] signUp success:', {
      hasSession: !!data.session,
      userId: data.user?.id ?? null,
      emailConfirmedAt: data.user?.email_confirmed_at ?? null,
    });

    // Supabase returns a session immediately if email confirmation is disabled,
    // or a user with no session if confirmation is required.
    // data.session === null means confirmation email was sent.
    if (data.session) {
      // Confirmation disabled — onAuthStateChange fires, Stack.Protected navigates automatically.
      return;
    }

    // Confirmation required — show the pending state.
    setPendingConfirmation(true);
  }

  const s = styles(theme, insets);

  // ── Confirmation pending state ──────────────────────────────────────────
  if (pendingConfirmation) {
    return (
      <View style={[s.flex, s.centerContent]}>
        <View style={s.confirmCard}>
          <ThemedText style={s.confirmEmoji}>📬</ThemedText>
          <ThemedText type="subtitle" style={s.confirmTitle}>Cek email kamu</ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={s.confirmBody}>
            Kami mengirim link konfirmasi ke{'\n'}
            <ThemedText type="smallBold">{email.trim().toLowerCase()}</ThemedText>
            {'\n\n'}Klik link tersebut untuk mengaktifkan akun, lalu kembali ke sini untuk masuk.
          </ThemedText>
          <Pressable
            style={({ pressed }) => [s.primaryButton, pressed && s.primaryButtonPressed]}
            onPress={() => router.replace('/auth/login')}
            accessibilityRole="button"
            accessibilityLabel="Pergi ke halaman masuk">
            <ThemedText style={s.primaryButtonText}>Ke halaman masuk</ThemedText>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Registration form ────────────────────────────────────────────────────
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
          <ThemedText type="subtitle" style={s.cardTitle}>Buat Akun</ThemedText>

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
              placeholder="Minimal 6 karakter"
              placeholderTextColor={theme.textSecondary}
              secureTextEntry
              autoComplete="new-password"
              value={password}
              onChangeText={(v) => { setPassword(v); setPasswordError(null); setConfirmError(null); setFormError(null); }}
              returnKeyType="next"
              editable={!loading}
            />
            {passwordError && (
              <ThemedText type="small" style={s.fieldError}>{passwordError}</ThemedText>
            )}
          </View>

          {/* Confirm password */}
          <View style={s.fieldGroup}>
            <ThemedText type="small" style={s.label}>Konfirmasi Password</ThemedText>
            <TextInput
              style={[
                s.input,
                { color: theme.text, borderColor: confirmError ? '#EF4444' : theme.backgroundSelected },
              ]}
              placeholder="Ulangi password"
              placeholderTextColor={theme.textSecondary}
              secureTextEntry
              autoComplete="new-password"
              value={confirm}
              onChangeText={(v) => { setConfirm(v); setConfirmError(null); setFormError(null); }}
              onSubmitEditing={handleRegister}
              returnKeyType="done"
              editable={!loading}
            />
            {confirmError && (
              <ThemedText type="small" style={s.fieldError}>{confirmError}</ThemedText>
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
            style={({ pressed }) => [
              s.primaryButton,
              pressed && s.primaryButtonPressed,
              loading && s.primaryButtonDisabled,
            ]}
            onPress={handleRegister}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel="Buat akun baru">
            {loading
              ? <ActivityIndicator color="#ffffff" />
              : <ThemedText style={s.primaryButtonText}>Daftar</ThemedText>
            }
          </Pressable>
        </View>

        {/* Footer nav */}
        <View style={s.footer}>
          <ThemedText type="small" themeColor="textSecondary">Sudah punya akun?</ThemedText>
          <Pressable
            onPress={() => router.push('/auth/login')}
            disabled={loading}
            accessibilityRole="link"
            accessibilityLabel="Masuk ke akun">
            <ThemedText type="small" style={s.linkText}>Masuk</ThemedText>
          </Pressable>
        </View>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Styles
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
    centerContent: {
      alignItems: 'center',
      justifyContent: 'center',
      padding: Spacing.four,
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
    // Confirmation state
    confirmCard: {
      alignItems: 'center',
      gap: Spacing.three,
      maxWidth: 360,
    },
    confirmEmoji: {
      fontSize: 56,
    },
    confirmTitle: {
      textAlign: 'center',
    },
    confirmBody: {
      textAlign: 'center',
      lineHeight: 22,
    },
  });
}
