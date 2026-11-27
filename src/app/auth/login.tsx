import { router } from 'expo-router';
import { useState } from 'react';
import { Image } from 'expo-image';
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
import { androidRipple } from '@/components/ui/android-ripple';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { startGoogleOAuth } from '@/lib/auth-oauth';
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
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

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

  async function handleGoogleLogin() {
    clearErrors();
    setGoogleLoading(true);
    try {
      const result = await startGoogleOAuth();
      if (!result.success && result.message) setFormError(result.message);
    } finally {
      setGoogleLoading(false);
    }
  }

  const busy = loading || googleLoading;

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
          <Image
            source={theme.background === '#121212'
              ? require('@/assets/images/mathwake-mark.png')
              : require('@/assets/images/mathwake-mark-light.png')}
            style={s.logoMark}
            contentFit="contain"
            accessible={false}
          />
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
                { color: theme.text, borderColor: emailError ? theme.danger : theme.border },
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
              editable={!busy}
            />
            {emailError && (
              <ThemedText type="small" style={s.fieldError}>{emailError}</ThemedText>
            )}
          </View>

          {/* Password */}
          <View style={s.fieldGroup}>
            <ThemedText type="small" style={s.label}>Password</ThemedText>
            <View style={s.passwordContainer}>
              <TextInput
                style={[
                  s.input,
                  s.passwordInput,
                  { color: theme.text, borderColor: passwordError ? theme.danger : theme.border },
                ]}
                placeholder="••••••••"
                placeholderTextColor={theme.textSecondary}
                secureTextEntry={!passwordVisible}
                autoComplete="current-password"
                value={password}
                onChangeText={(v) => { setPassword(v); setPasswordError(null); setFormError(null); }}
                onSubmitEditing={handleLogin}
                returnKeyType="done"
                editable={!busy}
              />
              <Pressable
                onPress={() => setPasswordVisible((v) => !v)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={passwordVisible ? 'Sembunyikan password' : 'Tampilkan password'}
                style={s.eyeButton}
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
            {passwordError && (
              <ThemedText type="small" style={s.fieldError}>{passwordError}</ThemedText>
            )}
          </View>

          <Pressable
            // Typed routes are regenerated by Expo Router's bundler for new files.
            onPress={() => router.push('/password-recovery' as never)}
            disabled={busy}
            accessibilityRole="link"
            accessibilityLabel="Lupa password"
            hitSlop={8}
            style={({ pressed }) => [s.inlineLink, pressed && s.linkPressed]}>
            <ThemedText type="small" style={s.forgotPasswordText}>Lupa password?</ThemedText>
          </Pressable>

          {/* Form-level error */}
          {formError && (
            <View style={s.formErrorBox} accessibilityRole="alert" accessibilityLiveRegion="polite">
              <ThemedText type="small" style={s.formErrorText}>{formError}</ThemedText>
            </View>
          )}

          {/* Submit */}
          <Pressable
            style={({ pressed }) => [s.primaryButton, pressed && s.primaryButtonPressed, busy && s.primaryButtonDisabled]}
            onPress={handleLogin}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Masuk ke akun"
            android_ripple={androidRipple(theme.onPrimary)}>
            {loading
              ? <ActivityIndicator color={theme.onPrimary} />
              : <ThemedText style={s.primaryButtonText}>Masuk</ThemedText>
            }
          </Pressable>

          <View style={s.divider}>
            <View style={s.dividerLine} />
            <ThemedText type="small" themeColor="textSecondary">atau</ThemedText>
            <View style={s.dividerLine} />
          </View>

          <Pressable
            style={({ pressed }) => [s.googleButton, pressed && s.googleButtonPressed, googleLoading && s.googleButtonDisabled]}
            onPress={handleGoogleLogin}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Masuk dengan Google"
            android_ripple={androidRipple(theme.primarySoft)}>
            {googleLoading
              ? <ActivityIndicator color={theme.text} />
              : <ThemedText style={s.googleButtonText}>Masuk dengan Google</ThemedText>
            }
          </Pressable>
        </View>

        {/* Footer nav */}
        <View style={s.footer}>
          <ThemedText type="small" themeColor="textSecondary">Belum punya akun?</ThemedText>
          <Pressable
            onPress={() => router.push('/auth/register')}
            disabled={busy}
            accessibilityRole="link"
            accessibilityLabel="Buat akun baru"
            hitSlop={8}
            style={({ pressed }) => [s.inlineLink, pressed && s.linkPressed]}>
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
      marginBottom: Spacing.two,
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
      borderRadius: Radius.block,
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
      minHeight: 48,
      borderWidth: 1.5,
      borderRadius: Radius.control,
      paddingHorizontal: Spacing.three,
      paddingVertical: Platform.OS === 'ios' ? 14 : 10,
      fontSize: 16,
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
    fieldError: {
      color: theme.danger,
    },
    formErrorBox: {
      backgroundColor: theme.dangerSoft,
      borderRadius: Radius.control,
      padding: Spacing.three,
    },
    formErrorText: {
      color: theme.danger,
    },
    primaryButton: {
      backgroundColor: theme.primary,
      borderRadius: Radius.control,
      minHeight: 52,
      justifyContent: 'center',
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
      color: theme.onPrimary,
      fontWeight: '700',
      fontSize: 16,
    },
    divider: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.two,
      marginVertical: Spacing.one,
    },
    dividerLine: {
      flex: 1,
      height: 1,
      backgroundColor: theme.backgroundSelected,
    },
    googleButton: {
      borderWidth: 1,
      borderColor: theme.backgroundSelected,
      borderRadius: Radius.control,
      minHeight: 52,
      justifyContent: 'center',
      paddingVertical: 15,
      alignItems: 'center',
    },
    googleButtonPressed: {
      opacity: 0.85,
    },
    googleButtonDisabled: {
      opacity: 0.6,
    },
    googleButtonText: {
      color: theme.text,
      fontWeight: '700',
      fontSize: 16,
    },
    forgotPasswordText: {
      color: theme.primaryStrong,
      fontWeight: '600',
      textAlign: 'right',
    },
    inlineLink: { minHeight: 48, justifyContent: 'center' },
    linkPressed: { opacity: 0.75 },
    footer: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: Spacing.one,
      alignItems: 'center',
    },
    linkText: {
      color: theme.primaryStrong,
      fontWeight: '700',
    },
  });
}
