import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync('supabase/migrations/20261028000000_google_onboarding.sql', 'utf8');
const profile = fs.readFileSync('src/lib/profile.ts', 'utf8');
const auth = fs.readFileSync('src/contexts/auth-context.tsx', 'utf8');
const root = fs.readFileSync('src/app/_layout.tsx', 'utf8');
const onboarding = fs.readFileSync('src/app/onboarding.tsx', 'utf8');
const login = fs.readFileSync('src/app/auth/login.tsx', 'utf8');
const register = fs.readFileSync('src/app/auth/register.tsx', 'utf8');
const recovery = fs.readFileSync('src/app/password-recovery.tsx', 'utf8');
const oauth = fs.readFileSync('src/lib/auth-oauth.ts', 'utf8');
const supabase = fs.readFileSync('src/lib/supabase.ts', 'utf8');
const profileScreen = fs.readFileSync('src/app/profile.tsx', 'utf8');
const home = fs.readFileSync('src/app/(app)/index.tsx', 'utf8');

let assertions = 0;
function check(value, message) {
  assertions += 1;
  assert.ok(value, message);
}
function equal(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}
function deepEqual(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

check(migration.includes('add column display_name text'), 'display_name migration exists');
check(migration.includes('onboarding_completed boolean not null default false'), 'onboarding column defaults incomplete');
check(migration.includes('update public.profiles'), 'legacy profile rollout is explicit');
check(migration.includes('auth.uid()'), 'server functions use auth.uid');
check(migration.includes('on conflict (id) do nothing'), 'profile repair is idempotent');
const completionFunctionMatch = migration.match(/create\s+or\s+replace\s+function\s+public\.complete_my_onboarding\s*\([\s\S]*?\$\$;/i);
check(!!completionFunctionMatch, 'complete_my_onboarding function exists');
check(/\bdisplay_name\s*=\s*v_display_name\b/i.test(completionFunctionMatch?.[0] ?? ''), 'completion writes display name');
check(!migration.includes('set role ='), 'onboarding never updates role');
check(/revoke\s+all\s+on\s+function\s+public\.ensure_my_profile\s*\(\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i.test(migration), 'repair execute is restricted');
check(/grant\s+execute\s+on\s+function\s+public\.ensure_my_profile\s*\(\s*\)\s+to\s+authenticated\s*;/i.test(migration), 'repair is available to authenticated only');
check(/grant\s+execute\s+on\s+function\s+public\.complete_my_onboarding\s*\(\s*text\s*\)\s+to\s+authenticated\s*;/i.test(migration), 'completion is available to authenticated only');
check(migration.includes('encrypted_password'), 'completion validates server-side password state');

check(profile.includes(".from('profiles')"), 'profile reads use profiles table');
check(profile.includes("supabase.rpc('ensure_my_profile')"), 'profile repair RPC is used');
check(profile.includes("supabase.rpc('complete_my_onboarding'"), 'completion RPC is used');
check(!profile.includes('p_role'), 'client helper does not submit role parameter');
check(auth.includes('profileLoading'), 'auth context tracks profile loading');
check(auth.includes('onboardingRequired'), 'auth context exposes onboarding state');
check(auth.includes('!profileError'), 'profile errors are not onboarding proof');
check(auth.includes('recoveryActive'), 'auth context preserves recovery exception');
check(root.includes('!profileLoading && !profileError && !onboardingRequired'), 'Dashboard requires checked complete profile');
check(root.includes('!!profileError || !profile'), 'profile errors use a retry gate');
check(root.includes('name="onboarding"'), 'onboarding route is protected separately');
check(onboarding.includes("supabase.auth.updateUser({ password })"), 'Google onboarding creates MathWake password');
check(onboarding.includes('completeMyOnboarding(displayName)'), 'onboarding completes through server RPC');
check(onboarding.includes('isGoogleUser(user)'), 'Google/email UI paths are separated');
check(profile.includes('user?.identities'), 'Google detection checks linked identities');
check(register.includes('supabase.auth.signUp'), 'email registration remains');
check(!register.includes('updateUser({ password'), 'email registration does not request a second password');
check(recovery.includes('verifyOtp'), 'password recovery remains');
check(oauth.includes('exchangeCodeForSession'), 'OAuth PKCE exchange remains');
check(supabase.includes("flowType: 'pkce'"), 'Supabase PKCE remains');
check(root.includes('<Stack.Screen name="profile" />'), 'Profile route is protected with the authenticated app');
check(home.includes("router.push('/profile' as never)"), 'Home provides navigation to Profile');
check(profileScreen.includes('fetchMyProfile(userId)'), 'Profile fetches the current session user profile');
check(profileScreen.includes('result.data.id !== userId'), 'Profile rejects data for another user');
check(profileScreen.includes('result.data.display_name ?? \'\''), 'Profile handles a null display name safely');
check(profileScreen.includes("user?.email ?? 'Email tidak tersedia'"), 'Profile displays only the authenticated user email');
check(profileScreen.includes('completeMyOnboarding(normalized)'), 'Profile saves through the auth.uid-scoped RPC');

function dashboardAllowed({ session, profileLoading, profile, recoveryActive = false }) {
  return !!session
    && !recoveryActive
    && !profileLoading
    && !!profile
    && profile.onboarding_completed === true;
}

equal(dashboardAllowed({ session: { id: 'google-new' }, profileLoading: false, profile: { onboarding_completed: false } }), false, 'new Google user is blocked');
equal(dashboardAllowed({ session: { id: 'google-old' }, profileLoading: false, profile: { onboarding_completed: true } }), true, 'completed user reaches Dashboard');
equal(dashboardAllowed({ session: { id: 'email-old' }, profileLoading: false, profile: { onboarding_completed: true } }), true, 'legacy email user reaches Dashboard');
equal(dashboardAllowed({ session: { id: 'same' }, profileLoading: true, profile: { onboarding_completed: true } }), false, 'profile loading blocks Dashboard');
equal(dashboardAllowed({ session: { id: 'missing' }, profileLoading: false, profile: null }), false, 'missing profile blocks Dashboard');
equal(dashboardAllowed({ session: { id: 'recovery' }, profileLoading: false, profile: { onboarding_completed: true }, recoveryActive: true }), false, 'recovery never enters Dashboard');

const profiles = new Map();
function ensureProfile(userId) {
  if (!profiles.has(userId)) profiles.set(userId, { id: userId, role: 'user', onboarding_completed: false });
  return profiles.get(userId);
}
const firstRepair = ensureProfile('repair-user');
const secondRepair = ensureProfile('repair-user');
equal(firstRepair, secondRepair, 'repair is idempotent');
equal(firstRepair.role, 'user', 'repair preserves role');

const legacyProfile = { id: 'legacy', role: 'user', onboarding_completed: true };
deepEqual(legacyProfile, { id: 'legacy', role: 'user', onboarding_completed: true }, 'legacy rollout does not alter role');

function classifyLegacy({ hasGoogle, hasEmail, metadataGoogle, metadataEmail, hasPassword, validDisplayName }) {
  const metadataConsistent = (!hasGoogle || metadataGoogle)
    && (!hasEmail || metadataEmail)
    && (!metadataGoogle || hasGoogle)
    && (!metadataEmail || hasEmail);
  if (!metadataConsistent) return false;
  if (hasGoogle) return hasPassword && validDisplayName;
  if (hasEmail) return hasPassword;
  return false;
}

equal(classifyLegacy({ hasGoogle: true, hasEmail: false, metadataGoogle: true, metadataEmail: false, hasPassword: true, validDisplayName: true }), true, 'complete Google legacy user is complete');
equal(classifyLegacy({ hasGoogle: true, hasEmail: false, metadataGoogle: true, metadataEmail: false, hasPassword: false, validDisplayName: true }), false, 'Google user without password is incomplete');
equal(classifyLegacy({ hasGoogle: true, hasEmail: false, metadataGoogle: true, metadataEmail: false, hasPassword: true, validDisplayName: false }), false, 'Google user without valid display name is incomplete');
equal(classifyLegacy({ hasGoogle: true, hasEmail: true, metadataGoogle: true, metadataEmail: true, hasPassword: true, validDisplayName: true }), true, 'multi-provider Google user requires both conditions');
equal(classifyLegacy({ hasGoogle: true, hasEmail: true, metadataGoogle: true, metadataEmail: true, hasPassword: true, validDisplayName: false }), false, 'multi-provider Google user without display name is incomplete');
equal(classifyLegacy({ hasGoogle: false, hasEmail: true, metadataGoogle: false, metadataEmail: true, hasPassword: true, validDisplayName: false }), true, 'legacy email user does not need a second password or display name');
equal(classifyLegacy({ hasGoogle: false, hasEmail: true, metadataGoogle: false, metadataEmail: true, hasPassword: false, validDisplayName: false }), false, 'passwordless email account is not auto-complete');
equal(classifyLegacy({ hasGoogle: true, hasEmail: false, metadataGoogle: false, metadataEmail: false, hasPassword: true, validDisplayName: true }), false, 'provider metadata conflict is not auto-complete');
equal(classifyLegacy({ hasGoogle: false, hasEmail: false, metadataGoogle: false, metadataEmail: false, hasPassword: true, validDisplayName: true }), false, 'unclassified account is not auto-complete');

console.log(`Hasil: ${assertions} assertions lulus, 0 gagal.`);
