import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  PROFILE_DISPLAY_NAME_MAX_LENGTH,
  RECOVERY_PASSWORD_MIN_LENGTH,
  validateProfileDisplayName,
  validateRecoveryPassword,
} from '../src/lib/account-validation.ts';

const profileScreen = fs.readFileSync('src/app/profile.tsx', 'utf8');
const recoveryScreen = fs.readFileSync('src/app/password-recovery.tsx', 'utf8');
const root = fs.readFileSync('src/app/_layout.tsx', 'utf8');
const loginScreen = fs.readFileSync('src/app/auth/login.tsx', 'utf8');
const registerScreen = fs.readFileSync('src/app/auth/register.tsx', 'utf8');
const themePreference = fs.readFileSync('src/contexts/theme-preference-context.tsx', 'utf8');

assert.equal(PROFILE_DISPLAY_NAME_MAX_LENGTH, 80);
assert.equal(validateProfileDisplayName('  '), 'Nama harus berisi 1 sampai 80 karakter.');
assert.equal(validateProfileDisplayName('  Math Wake  '), null);
assert.equal(validateProfileDisplayName('x'.repeat(80)), null);
assert.equal(validateProfileDisplayName('x'.repeat(81)), 'Nama harus berisi 1 sampai 80 karakter.');

assert.equal(RECOVERY_PASSWORD_MIN_LENGTH, 6);
assert.equal(validateRecoveryPassword('', ''), 'Password tidak boleh kosong.');
assert.equal(validateRecoveryPassword('12345', '12345'), 'Password minimal 6 karakter.');
assert.equal(validateRecoveryPassword('123456', ''), 'Konfirmasi password tidak boleh kosong.');
assert.equal(validateRecoveryPassword('123456', '654321'), 'Password tidak cocok.');
assert.equal(validateRecoveryPassword('123456', '123456'), null);

assert.match(profileScreen, /fetchMyProfile\(userId\)/);
assert.match(profileScreen, /completeMyOnboarding\(normalized\)/);
assert.match(profileScreen, /result\.error \|\| !result\.data \|\| result\.data\.id !== user\.id/);
const saveBlock = profileScreen.match(/async function saveDisplayName\(\) \{([\s\S]*?)\n  \}/)?.[1] ?? '';
assert.match(saveBlock, /setSaved\(true\)/);
assert.ok(saveBlock.indexOf('setSaved(true)') > saveBlock.indexOf('result.error || !result.data'));
assert.match(profileScreen, /saveInFlight\.current/);
assert.match(profileScreen, /router\.push\('\/password-recovery'/);
assert.doesNotMatch(profileScreen, /SectionHeading title="Profil"/);
assert.match(profileScreen, /accessibilityLabel="Nama profil"/);
assert.match(profileScreen, /user\?\.email/);
assert.match(profileScreen, /SectionHeading title="Keamanan"/);
assert.match(profileScreen, /SectionHeading title="Tampilan"/);
assert.match(recoveryScreen, /KEAMANAN AKUN/);
assert.match(recoveryScreen, /progressTrack/);
assert.match(recoveryScreen, /accessibilityLabel="Kode OTP"/);
assert.match(profileScreen, /THEME_OPTIONS\.map/);
assert.match(profileScreen, /accessibilityRole="radiogroup"/);
assert.match(profileScreen, /accessibilityRole="radio"/);
assert.match(root, /<ThemePreferenceProvider>/);
assert.match(themePreference, /Appearance\.setColorScheme/);
assert.match(themePreference, /AsyncStorage\.getItem\(THEME_PREFERENCE_KEY\)/);
assert.match(themePreference, /AsyncStorage\.setItem\(THEME_PREFERENCE_KEY, next\)/);
assert.match(loginScreen, /assets\/images\/mathwake-mark\.png/);
assert.match(loginScreen, /assets\/images\/mathwake-mark-light\.png/);
assert.match(registerScreen, /assets\/images\/mathwake-mark\.png/);
assert.match(registerScreen, /assets\/images\/mathwake-mark-light\.png/);
assert.doesNotMatch(loginScreen, /ios: 'alarm\.fill'/);
assert.doesNotMatch(registerScreen, /ios: 'alarm\.fill'/);
assert.match(profileScreen, /user\?\.email \?\? 'Email tidak tersedia'/);
assert.doesNotMatch(profileScreen, /const \[email, setEmail\]/);
assert.match(profileScreen, /setSaving\(true\);[\s\S]*finally \{[\s\S]*setSaving\(false\)/);
assert.match(profileScreen, /setError\('Nama profil tidak dapat disimpan/);

assert.match(root, /<Stack\.Screen name="password-recovery" \/>/);
assert.doesNotMatch(root, /Stack\.Protected guard=\{!session \|\| recoveryActive\}>\s*<Stack\.Screen name="password-recovery"/);
assert.match(recoveryScreen, /resetPasswordForEmail\(/);
assert.match(recoveryScreen, /PASSWORD_RECOVERY|recoveryActive/);
assert.match(recoveryScreen, /if \(!recoveryActive \|\| !recoveryExpiresAt \|\| recoveryExpiresAt <= Date\.now\(\)\)/);
assert.match(recoveryScreen, /supabase\.auth\.updateUser\(\{ password \}\)/);
assert.match(recoveryScreen, /requestInFlight\.current/);
assert.match(recoveryScreen, /resendUntil !== null && resendUntil > Date\.now\(\)/);
assert.match(recoveryScreen, /setLoading\(true\);[\s\S]*finally \{[\s\S]*setLoading\(false\)/);
assert.match(recoveryScreen, /setFormError\(recoveryErrorMessage\(error\.message\)\)/);
assert.match(recoveryScreen, /secureTextEntry=\{!passwordVisible\}/);
assert.match(recoveryScreen, /secureTextEntry=\{!confirmationVisible\}/);
assert.match(recoveryScreen, /router\.replace\(user \? '\/profile' : '\/auth\/login'\)/);

function recoveryRouteAvailable() {
  return true;
}
function passwordFormAvailable({ recoveryActive, recoveryExpiresAt, now }) {
  return recoveryActive && recoveryExpiresAt !== null && recoveryExpiresAt > now;
}
assert.equal(recoveryRouteAvailable(), true, 'reset request route is reachable while signed in or out');
assert.equal(passwordFormAvailable({ recoveryActive: false, recoveryExpiresAt: null, now: 0 }), false);
assert.equal(passwordFormAvailable({ recoveryActive: true, recoveryExpiresAt: 100, now: 100 }), false);
assert.equal(passwordFormAvailable({ recoveryActive: true, recoveryExpiresAt: 101, now: 100 }), true);

console.log('Hasil: 42 assertions lulus, 0 gagal.');
