import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
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
import { recoveryCompletionAfterUpdate, type RecoveryCompletion, type LocalSessionStatus } from '@/lib/recovery-completion';
import { supabase } from '@/lib/supabase';
import {
  PASSWORD_RECOVERY_REDIRECT_URI,
  normalizeRecoveryEmail,
  recoveryErrorMessage,
  validateRecoveryEmail,
  validateRecoveryOtp,
  validateRecoveryPassword,
} from '@/lib/password-recovery';

type RecoveryPhase = 'request' | 'otp' | 'password' | 'success';

export default function PasswordRecoveryScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const {
    user,
    recoveryActive,
    recoveryExpiresAt,
    markRecoveryVerified,
    clearRecovery,
  } = useAuth();
  const [phase, setPhase] = useState<RecoveryPhase>(recoveryActive ? 'password' : 'request');
  const [email, setEmail] = useState(user?.email ?? '');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [confirmationVisible, setConfirmationVisible] = useState(false);
  const [resendUntil, setResendUntil] = useState<number | null>(null);
  const [completion, setCompletion] = useState<RecoveryCompletion | null>(null);
  const requestInFlight = useRef(false);

  useEffect(() => {
    if (!resendUntil) return undefined;
    const timer = setTimeout(() => setResendUntil(null), Math.max(0, resendUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [resendUntil]);

  async function requestOtp() {
    setFormError(null);
    const emailError = validateRecoveryEmail(email);
    if (emailError) {
      setFormError(emailError);
      return;
    }
    if (requestInFlight.current || loading || (resendUntil !== null && resendUntil > Date.now())) return;

    requestInFlight.current = true;
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(
        normalizeRecoveryEmail(email),
        { redirectTo: PASSWORD_RECOVERY_REDIRECT_URI },
      );
      setResendUntil(Date.now() + 60_000);
      if (error) {
        setFormError(recoveryErrorMessage(error.message));
        return;
      }
      setPhase('otp');
    } catch {
      setFormError('Tidak dapat terhubung. Periksa koneksi internet kamu.');
    } finally {
      requestInFlight.current = false;
      setLoading(false);
    }
  }

  async function verifyOtp() {
    setFormError(null);
    const emailError = validateRecoveryEmail(email);
    const otpError = validateRecoveryOtp(otp);
    if (emailError || otpError) {
      setFormError(emailError ?? otpError);
      return;
    }
    if (loading) return;

    setLoading(true);
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        email: normalizeRecoveryEmail(email),
        token: otp.replace(/\s/g, ''),
        type: 'recovery',
      });
      if (error) {
        setFormError(recoveryErrorMessage(error.message));
        return;
      }
      if (!data.session) {
        setFormError('Sesi pemulihan tidak tersedia. Minta kode baru lalu coba lagi.');
        return;
      }
      await markRecoveryVerified(data.session);
      setPhase('password');
    } catch {
      setFormError('Kode OTP salah atau sudah kedaluwarsa. Minta kode baru lalu coba lagi.');
    } finally {
      setLoading(false);
    }
  }

  async function updatePassword() {
    setFormError(null);
    const passwordError = validateRecoveryPassword(password, confirmation);
    if (passwordError) {
      setFormError(passwordError);
      return;
    }
    if (loading) return;
    if (!recoveryActive || !recoveryExpiresAt || recoveryExpiresAt <= Date.now()) {
      await clearRecovery();
      setFormError('Sesi pemulihan sudah berakhir. Mulai ulang proses pemulihan.');
      return;
    }

    setLoading(true);
    let updateError: string | null = null;
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        updateError = recoveryErrorMessage(error.message);
      }
    } catch {
      updateError = 'Password gagal diperbarui. Coba lagi nanti.';
    }

    if (updateError) {
      setFormError(updateError);
      setLoading(false);
      return;
    }

    let signOutFailed = false;
    try {
      const { error: signOutError } = await supabase.auth.signOut();
      signOutFailed = !!signOutError;
    } catch {
      signOutFailed = true;
    }

    const localSessionStatus = await readLocalSessionStatus();
    const markerCleared = localSessionStatus === 'signed-out'
      ? await clearRecovery()
      : false;
    const result = recoveryCompletionAfterUpdate({
      signOutError: signOutFailed,
      localSessionStatus,
      recoveryMarkerCleared: markerCleared,
    });

    setLoading(false);
    setPhase('success');
    setCompletion(result);
    if (result.nextStep === 'login' && !signOutFailed && markerCleared) {
      router.replace('/auth/login');
    }
  }

  async function readLocalSessionStatus(): Promise<LocalSessionStatus> {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) return 'unknown';
      return data.session ? 'signed-in' : 'signed-out';
    } catch {
      return 'unknown';
    }
  }

  async function retrySignOutAfterUpdate() {
    if (loading) return;
    setFormError(null);
    setLoading(true);
    let signOutFailed = false;
    try {
      const { error } = await supabase.auth.signOut();
      signOutFailed = !!error;
    } catch {
      signOutFailed = true;
    }
    const localSessionStatus = await readLocalSessionStatus();
    const markerCleared = localSessionStatus === 'signed-out'
      ? await clearRecovery()
      : false;
    const result = recoveryCompletionAfterUpdate({
      signOutError: signOutFailed,
      localSessionStatus,
      recoveryMarkerCleared: markerCleared,
    });
    setCompletion(result);
    setLoading(false);
    if (result.nextStep === 'login' && !signOutFailed && markerCleared) {
      router.replace('/auth/login');
    }
  }

  async function leaveRecovery() {
    if (loading) return;
    if (!recoveryActive) {
      router.replace(user ? '/profile' : '/auth/login');
      return;
    }

    setFormError(null);
    setLoading(true);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        setFormError('Sesi pemulihan belum dapat ditutup. Coba lagi atau selesaikan reset password.');
        return;
      }
      await clearRecovery();
      router.replace('/auth/login');
    } catch {
      setFormError('Sesi pemulihan belum dapat ditutup. Periksa koneksi lalu coba lagi.');
    } finally {
      setLoading(false);
    }
  }

  const s = styles(theme, insets);
  const displayPhase: RecoveryPhase = recoveryActive
    ? phase === 'success' ? 'success' : 'password'
    : phase === 'password' ? 'request' : phase;
  const resendActive = resendUntil !== null;
  const title = displayPhase === 'request'
    ? 'Lupa password?'
    : displayPhase === 'otp'
      ? 'Masukkan kode OTP'
      : displayPhase === 'password'
        ? 'Buat password baru'
        : 'Password diperbarui';

  return (
    <KeyboardAvoidingView
      style={s.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <View style={s.card}>
          <ThemedText type="subtitle" style={s.title}>{title}</ThemedText>

          {displayPhase === 'request' && (
            <>
              <ThemedText type="small" themeColor="textSecondary">
                Masukkan email akun kamu. Jika email tersebut terhubung ke akun, kode reset akan dikirim.
              </ThemedText>
              <TextInput
                style={s.input}
                placeholder="kamu@email.com"
                placeholderTextColor={theme.textSecondary}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                value={email}
                onChangeText={(value) => { setEmail(value); setFormError(null); }}
                editable={!loading}
              />
              <ActionButton label="Kirim kode reset" loading={loading} onPress={requestOtp} disabled={loading} />
            </>
          )}

          {displayPhase === 'otp' && (
            <>
              <ThemedText type="small" themeColor="textSecondary">
                Masukkan kode dari email untuk melanjutkan pemulihan password.
              </ThemedText>
              <TextInput
                style={s.input}
                placeholder="Kode OTP"
                placeholderTextColor={theme.textSecondary}
                keyboardType="number-pad"
                value={otp}
                onChangeText={(value) => { setOtp(value); setFormError(null); }}
                editable={!loading}
              />
              <ActionButton label="Verifikasi kode" loading={loading} onPress={verifyOtp} disabled={loading} />
              <Pressable
                onPress={requestOtp}
                disabled={loading || resendActive}
                accessibilityRole="button">
                <ThemedText type="small" style={s.linkText}>
                  {resendActive ? 'Tunggu sebelum kirim ulang' : 'Kirim ulang kode'}
                </ThemedText>
              </Pressable>
            </>
          )}

          {displayPhase === 'password' && (
            <>
              <View style={s.passwordField}>
                <TextInput
                  style={s.input}
                  placeholder="Password baru"
                  placeholderTextColor={theme.textSecondary}
                  secureTextEntry={!passwordVisible}
                  autoComplete="new-password"
                  value={password}
                  onChangeText={(value) => { setPassword(value); setFormError(null); }}
                  editable={!loading}
                />
                <Pressable onPress={() => setPasswordVisible((value) => !value)} disabled={loading} accessibilityRole="button" accessibilityLabel={passwordVisible ? 'Sembunyikan password' : 'Tampilkan password'}>
                  <ThemedText type="small" style={s.visibilityText}>{passwordVisible ? 'Sembunyikan' : 'Tampilkan'}</ThemedText>
                </Pressable>
              </View>
              <View style={s.passwordField}>
                <TextInput
                  style={s.input}
                  placeholder="Konfirmasi password"
                  placeholderTextColor={theme.textSecondary}
                  secureTextEntry={!confirmationVisible}
                  autoComplete="new-password"
                  value={confirmation}
                  onChangeText={(value) => { setConfirmation(value); setFormError(null); }}
                  editable={!loading}
                />
                <Pressable onPress={() => setConfirmationVisible((value) => !value)} disabled={loading} accessibilityRole="button" accessibilityLabel={confirmationVisible ? 'Sembunyikan konfirmasi password' : 'Tampilkan konfirmasi password'}>
                  <ThemedText type="small" style={s.visibilityText}>{confirmationVisible ? 'Sembunyikan' : 'Tampilkan'}</ThemedText>
                </Pressable>
              </View>
              <ActionButton label="Perbarui password" loading={loading} onPress={updatePassword} disabled={loading} />
            </>
          )}

          {displayPhase === 'success' && (
            <>
              <ThemedText type="small" themeColor="textSecondary">
                {completion?.message ?? 'Password berhasil diperbarui.'}
              </ThemedText>
              {completion?.nextStep === 'retry-sign-out' ? (
                <ActionButton label="Coba tutup sesi lagi" loading={loading} onPress={() => { void retrySignOutAfterUpdate(); }} disabled={loading} />
              ) : (
                <ActionButton label="Kembali ke login" loading={false} onPress={() => router.replace('/auth/login')} disabled={false} />
              )}
            </>
          )}

          {formError && <ThemedText type="small" style={s.error}>{formError}</ThemedText>}
          {displayPhase !== 'success' && (
            <Pressable onPress={() => { void leaveRecovery(); }} disabled={loading}>
              <ThemedText type="small" style={s.linkText}>
                {recoveryActive ? 'Batalkan reset dan keluar' : user ? 'Kembali ke profil' : 'Kembali ke login'}
              </ThemedText>
            </Pressable>
          )}
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
}: {
  label: string;
  loading: boolean;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <Pressable style={buttonStyles.button} onPress={onPress} disabled={disabled} accessibilityRole="button">
      {loading ? <ActivityIndicator color="#ffffff" /> : <ThemedText style={buttonStyles.text}>{label}</ThemedText>}
    </Pressable>
  );
}

const buttonStyles = StyleSheet.create({
  button: {
    backgroundColor: '#208AEF',
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
  },
  text: { color: '#ffffff', fontWeight: '700' },
});

function styles(theme: ReturnType<typeof useTheme>, insets: ReturnType<typeof useSafeAreaInsets>) {
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
    passwordField: { gap: Spacing.one },
    visibilityText: { color: '#208AEF', fontWeight: '600', textAlign: 'right' },
    error: { color: '#B91C1C' },
    linkText: { color: '#208AEF', fontWeight: '600', textAlign: 'center' },
  });
}
