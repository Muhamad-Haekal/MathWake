import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { router } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Accent, Danger, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/auth-context';
import { useTheme } from '@/hooks/use-theme';
import { PROFILE_DISPLAY_NAME_MAX_LENGTH, validateProfileDisplayName } from '@/lib/account-validation';
import {
  completeMyOnboarding,
  fetchMyProfile,
  isGoogleUser,
  type Profile,
} from '@/lib/profile';

export default function ProfileScreen() {
  const { user, refreshProfile } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const saveInFlight = useRef(false);

  useEffect(() => {
    const userId = user?.id;
    let active = true;
    if (!userId) {
      return () => { active = false; };
    }

    void Promise.resolve().then(() => {
      if (!active) return null;
      setProfile(null);
      setDisplayName('');
      setLoading(true);
      setError(null);
      return fetchMyProfile(userId);
    }).then((result) => {
      if (!result) return;
      if (!active) return;
      if (result.error || !result.data || result.data.id !== userId) {
        setProfile(null);
        setError('Profil belum dapat dimuat. Coba lagi nanti.');
        return;
      }
      setProfile(result.data);
      setDisplayName(result.data.display_name ?? '');
    }).catch(() => {
      if (active) {
        setProfile(null);
        setError('Profil belum dapat dimuat. Periksa koneksi lalu coba lagi.');
      }
    }).finally(() => {
      if (active) setLoading(false);
    });

    return () => { active = false; };
  }, [user?.id]);

  async function saveDisplayName() {
    if (saveInFlight.current || !user?.id) return;
    const normalized = displayName.trim();
    const validationError = validateProfileDisplayName(displayName);
    if (validationError) {
      setError(validationError);
      setSaved(false);
      return;
    }

    saveInFlight.current = true;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await completeMyOnboarding(normalized);
      if (result.error || !result.data || result.data.id !== user.id) {
        setError('Nama profil tidak dapat disimpan. Coba lagi nanti.');
        return;
      }
      setProfile(result.data);
      setDisplayName(result.data.display_name ?? '');
      setSaved(true);
      void refreshProfile().catch(() => undefined);
    } catch {
      setError('Nama profil tidak dapat disimpan. Periksa koneksi lalu coba lagi.');
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  function openPasswordRecovery() {
    router.push('/password-recovery' as never);
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + Spacing.four, paddingBottom: insets.bottom + Spacing.four }]}>
        <View style={styles.header}>
          <Pressable onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace('/');
          }} accessibilityRole="button" accessibilityLabel="Kembali">
            <ThemedText type="small" style={styles.backText}>Kembali</ThemedText>
          </Pressable>
          <ThemedText type="title">Pengaturan akun</ThemedText>
        </View>

        {loading ? (
          <ActivityIndicator color={Accent} accessibilityLabel="Memuat profil" />
        ) : (
          <View style={styles.card}>
            <ThemedText type="smallBold">Email</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">{user?.email ?? 'Email tidak tersedia'}</ThemedText>

            <ThemedText type="smallBold" style={styles.nameLabel}>Nama</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {profile?.display_name?.trim() || 'Nama belum diatur'}
            </ThemedText>
            <TextInput
              value={displayName}
              onChangeText={(value) => { setDisplayName(value); setSaved(false); }}
              maxLength={PROFILE_DISPLAY_NAME_MAX_LENGTH}
              editable={!saving}
              placeholder="Masukkan nama"
              placeholderTextColor={theme.textSecondary}
              autoCapitalize="words"
              autoCorrect={false}
              accessibilityLabel="Nama profil"
              style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.backgroundSelected }]}
            />

            {error ? <ThemedText type="small" style={styles.error}>{error}</ThemedText> : null}
            {saved ? <ThemedText type="small" style={styles.success}>Nama profil tersimpan.</ThemedText> : null}
            <Pressable
              onPress={() => { void saveDisplayName(); }}
              disabled={saving || loading || !profile}
              accessibilityRole="button"
              accessibilityLabel="Simpan nama profil"
              style={({ pressed }) => [styles.saveButton, pressed && styles.pressed, (saving || loading || !profile) && styles.disabled]}>
              <ThemedText type="small" style={styles.saveText}>{saving ? 'Menyimpan...' : 'Simpan nama'}</ThemedText>
            </Pressable>
          </View>
        )}

        {!loading ? (
          <View style={styles.card}>
            <ThemedText type="subtitle">Keamanan</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {isGoogleUser(user)
                ? 'Akun ini terhubung dengan Google. Reset password mengatur password untuk login MathWake; login Google tetap tersedia.'
                : 'Kirim kode pemulihan ke email akun untuk membuat password baru.'}
            </ThemedText>
            <Pressable
              onPress={openPasswordRecovery}
              accessibilityRole="button"
              accessibilityLabel="Reset password"
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
              <ThemedText type="small" style={styles.secondaryButtonText}>Reset password</ThemedText>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: Spacing.four, gap: Spacing.four },
  header: { gap: Spacing.two },
  backText: { color: Accent, fontWeight: '700' },
  card: { gap: Spacing.two, padding: Spacing.four, borderRadius: Radius.block },
  nameLabel: { marginTop: Spacing.two },
  input: { borderWidth: 1, borderRadius: Radius.control, paddingHorizontal: Spacing.three, paddingVertical: Spacing.three, fontSize: 16 },
  error: { color: Danger },
  success: { color: Accent },
  saveButton: { marginTop: Spacing.two, backgroundColor: Accent, borderRadius: Radius.control, paddingVertical: Spacing.three, alignItems: 'center' },
  saveText: { color: '#ffffff', fontWeight: '700' },
  secondaryButton: { borderWidth: 1, borderColor: Accent, borderRadius: Radius.control, paddingVertical: Spacing.three, alignItems: 'center' },
  secondaryButtonText: { color: Accent, fontWeight: '700' },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.5 },
});
