import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { router } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { androidRipple } from '@/components/ui/android-ripple';
import { Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/auth-context';
import { THEME_OPTIONS, useThemePreference } from '@/contexts/theme-preference-context';
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
  const { preference, setPreference } = useThemePreference();
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

  const displayLabel = profile?.display_name?.trim() || user?.email?.trim().charAt(0).toUpperCase() || 'M';
  return (
    <KeyboardAvoidingView style={[styles.container, { backgroundColor: theme.background }]} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + Spacing.three, paddingBottom: insets.bottom + Spacing.four },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        <View style={styles.page}>
          <View style={styles.navigation}>
            <Pressable
              onPress={() => {
                if (router.canGoBack()) router.back();
                else router.replace('/');
              }}
              accessibilityRole="button"
              accessibilityLabel="Kembali"
              hitSlop={8}
              style={({ pressed }) => [styles.backButton, { backgroundColor: theme.backgroundElement, borderColor: theme.border }, pressed && styles.pressed]}>
              <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={19} tintColor={theme.text} />
            </Pressable>
            <View style={styles.navigationText}>
              <ThemedText themeColor="textSecondary" style={styles.eyebrow}>AKUN</ThemedText>
              <ThemedText style={styles.pageTitle} accessibilityRole="header">Pengaturan akun</ThemedText>
            </View>
          </View>

          <View style={[styles.accountCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
            <View style={[styles.avatar, { backgroundColor: theme.primarySoft }]}>
              <ThemedText style={[styles.avatarText, { color: theme.primaryStrong }]}>{displayLabel}</ThemedText>
            </View>
            <View style={styles.accountInfo}>
              <ThemedText style={styles.accountName}>
                {profile?.display_name?.trim() || 'Akun MathWake'}
              </ThemedText>
              <ThemedText themeColor="textSecondary" style={styles.accountEmail}>
                {user?.email ?? 'Email tidak tersedia'}
              </ThemedText>
            </View>
          </View>

          {loading ? (
            <View style={[styles.loadingCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]} accessibilityLabel="Memuat profil">
              <ActivityIndicator color={theme.primary} />
              <ThemedText themeColor="textSecondary" style={styles.loadingText}>Memuat detail akun...</ThemedText>
            </View>
          ) : (
            <View style={styles.section}>
              <View style={[styles.card, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
                <View style={styles.fieldHeader}>
                  <ThemedText style={styles.fieldLabel}>Nama tampilan</ThemedText>
                  <ThemedText themeColor="textSecondary" style={styles.counter}>{displayName.length}/{PROFILE_DISPLAY_NAME_MAX_LENGTH}</ThemedText>
                </View>
                <TextInput
                  value={displayName}
                  onChangeText={(value) => { setDisplayName(value); setSaved(false); }}
                  maxLength={PROFILE_DISPLAY_NAME_MAX_LENGTH}
                  editable={!saving}
                  placeholder="Masukkan nama"
                  placeholderTextColor={theme.textSecondary}
                  autoCapitalize="words"
                  autoCorrect={false}
                  returnKeyType="done"
                  accessibilityLabel="Nama profil"
                  style={[styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.border }]}
                />
                <ThemedText themeColor="textSecondary" style={styles.fieldHint}>Nama digunakan untuk menyapa kamu di halaman utama.</ThemedText>

                {error ? (
                  <View style={[styles.feedback, { backgroundColor: theme.dangerSoft }]} accessibilityRole="alert">
                    <SymbolView name={{ ios: 'exclamationmark.circle.fill', android: 'error', web: 'error' }} size={17} tintColor={theme.danger} />
                    <ThemedText style={[styles.feedbackText, { color: theme.danger }]}>{error}</ThemedText>
                  </View>
                ) : null}
                {saved ? (
                  <View style={[styles.feedback, { backgroundColor: theme.successSoft }]} accessibilityLiveRegion="polite">
                    <SymbolView name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }} size={17} tintColor={theme.success} />
                    <ThemedText style={[styles.feedbackText, { color: theme.success }]}>Nama profil tersimpan.</ThemedText>
                  </View>
                ) : null}
                <Pressable
                  onPress={() => { void saveDisplayName(); }}
                  disabled={saving || loading || !profile}
                  accessibilityRole="button"
                  accessibilityLabel="Simpan nama profil"
                  accessibilityState={{ disabled: saving || loading || !profile, busy: saving }}
                  android_ripple={androidRipple(theme.onPrimary)}
                  style={({ pressed }) => [styles.saveButton, { backgroundColor: theme.primary }, pressed && styles.pressed, (saving || loading || !profile) && styles.disabled]}>
                  {saving ? <ActivityIndicator size="small" color={theme.onPrimary} /> : null}
                  <ThemedText style={[styles.saveText, { color: theme.onPrimary }]}>{saving ? 'Menyimpan...' : 'Simpan perubahan'}</ThemedText>
                </Pressable>
              </View>
            </View>
          )}

          {!loading ? (
            <View style={styles.section}>
              <SectionHeading title="Keamanan" caption="Akses dan lindungi akunmu" />
              <View style={[styles.card, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
                <View style={styles.securityIntro}>
                  <View style={[styles.rowIcon, { backgroundColor: theme.primarySoft }]}>
                    <SymbolView name={{ ios: isGoogleUser(user) ? 'person.crop.circle' : 'lock.fill', android: isGoogleUser(user) ? 'account_circle' : 'lock', web: isGoogleUser(user) ? 'account_circle' : 'lock' }} size={19} tintColor={theme.primaryStrong} />
                  </View>
                  <View style={styles.securityCopy}>
                    <ThemedText style={styles.fieldLabel}>{isGoogleUser(user) ? 'Akun Google' : 'Password akun'}</ThemedText>
                    <ThemedText themeColor="textSecondary" style={styles.fieldHint}>
                      {isGoogleUser(user)
                        ? 'Atur password MathWake tanpa mengubah akses Google.'
                        : 'Kirim kode pemulihan ke email akun untuk membuat password baru.'}
                    </ThemedText>
                  </View>
                </View>
                <Pressable
                  onPress={openPasswordRecovery}
                  accessibilityRole="button"
                  accessibilityLabel="Reset password akun"
                  style={({ pressed }) => [styles.actionRow, { borderColor: theme.border }, pressed && styles.rowPressed]}>
                  <ThemedText style={[styles.actionText, { color: theme.primaryStrong }]}>Reset password</ThemedText>
                  <SymbolView name={{ ios: 'arrow.up.right', android: 'north_east', web: 'north_east' }} size={17} tintColor={theme.primaryStrong} />
                </Pressable>
              </View>
            </View>
          ) : null}

          <View style={styles.section}>
            <SectionHeading title="Tampilan" caption="Preferensi visual aplikasi" />
            <View style={[styles.themeCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
              <View style={styles.themeHeading}>
                <View style={[styles.rowIcon, { backgroundColor: theme.primarySoft }]}>
                  <SymbolView name={{ ios: 'sun.max.fill', android: 'light_mode', web: 'light_mode' }} size={19} tintColor={theme.primaryStrong} />
                </View>
                <View style={styles.securityCopy}>
                  <ThemedText style={styles.fieldLabel}>Tema aplikasi</ThemedText>
                  <ThemedText themeColor="textSecondary" style={styles.fieldHint}>Pilih tampilan yang nyaman. Tema Sistem mengikuti pengaturan perangkat.</ThemedText>
                </View>
              </View>
              <View style={[styles.themeOptions, { backgroundColor: theme.background, borderColor: theme.border }]} accessibilityRole="radiogroup" accessibilityLabel="Pilihan tema aplikasi">
                {THEME_OPTIONS.map((option) => {
                  const selected = preference === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => { void setPreference(option.value); }}
                      accessibilityRole="radio"
                      accessibilityLabel={`Tema ${option.label}`}
                      accessibilityState={{ checked: selected }}
                      android_ripple={androidRipple(theme.primarySoft)}
                      style={({ pressed }) => [
                        styles.themeOption,
                        selected && { backgroundColor: theme.primary, borderColor: theme.primary },
                        pressed && styles.rowPressed,
                      ]}>
                      <ThemedText style={[styles.themeOptionText, selected && { color: theme.onPrimary }]}>{option.label}</ThemedText>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function SectionHeading({ title, caption }: { title: string; caption: string }) {
  return (
    <View style={styles.sectionHeading}>
      <ThemedText style={styles.sectionTitle}>{title}</ThemedText>
      <ThemedText themeColor="textSecondary" style={styles.sectionCaption}>{caption}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: Spacing.four },
  page: { width: '100%', maxWidth: 560, alignSelf: 'center', gap: Spacing.four },
  navigation: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  backButton: { width: 48, height: 48, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  navigationText: { gap: 1 },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.3 },
  pageTitle: { fontSize: 25, lineHeight: 31, fontWeight: '800', letterSpacing: -0.4 },
  accountCard: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three, padding: Spacing.three, borderRadius: Radius.block + 2, borderWidth: 1 },
  avatar: { width: 54, height: 54, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 22, fontWeight: '800' },
  accountInfo: { flex: 1, minWidth: 0, gap: 3 },
  accountName: { fontSize: 17, fontWeight: '700', flexShrink: 1 },
  accountEmail: { fontSize: 13, lineHeight: 18 },
  section: { gap: Spacing.two },
  sectionHeading: { gap: 2 },
  sectionTitle: { fontSize: 18, fontWeight: '800' },
  sectionCaption: { fontSize: 13 },
  card: { borderRadius: Radius.block, borderWidth: 1, padding: Spacing.four, gap: Spacing.three },
  fieldHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  fieldLabel: { fontSize: 15, fontWeight: '700' },
  counter: { fontSize: 12, fontVariant: ['tabular-nums'] },
  input: { minHeight: 52, borderWidth: 1, borderRadius: Radius.control, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, fontSize: 16 },
  fieldHint: { fontSize: 13, lineHeight: 19 },
  feedback: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.two, borderRadius: Radius.control, padding: Spacing.three },
  feedbackText: { flex: 1, fontSize: 13, lineHeight: 19, fontWeight: '600' },
  saveButton: { minHeight: 52, borderRadius: Radius.control, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.two, marginTop: Spacing.one },
  saveText: { fontSize: 15, fontWeight: '800' },
  securityIntro: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.three },
  rowIcon: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  securityCopy: { flex: 1, gap: 4 },
  actionRow: { minHeight: 48, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: Spacing.three, gap: Spacing.two },
  actionText: { fontSize: 14, fontWeight: '700' },
  themeCard: { borderRadius: Radius.block, borderWidth: 1, padding: Spacing.three, gap: Spacing.three },
  themeHeading: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  themeOptions: { flexDirection: 'row', padding: 4, gap: Spacing.two, borderWidth: 1, borderRadius: Radius.control },
  themeOption: { minHeight: 48, flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 9, borderWidth: 1, borderColor: 'transparent' },
  themeOptionText: { fontSize: 14, fontWeight: '700' },
  loadingCard: { minHeight: 112, borderRadius: Radius.block, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
  loadingText: { fontSize: 14 },
  pressed: { opacity: 0.85, transform: [{ scale: 0.99 }] },
  rowPressed: { opacity: 0.7 },
  disabled: { opacity: 0.55 },
});
