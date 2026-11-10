import assert from 'node:assert/strict';
import fs from 'node:fs';

const supabase = fs.readFileSync('src/lib/supabase.ts', 'utf8');
const auth = fs.readFileSync('src/contexts/auth-context.tsx', 'utf8');
const home = fs.readFileSync('src/hooks/use-home-data.ts', 'utf8');
const alarms = fs.readFileSync('src/hooks/use-alarms.ts', 'utf8');
const homeScreen = fs.readFileSync('src/app/(app)/index.tsx', 'utf8');
const root = fs.readFileSync('src/app/_layout.tsx', 'utf8');
const authLayout = fs.readFileSync('src/app/auth/_layout.tsx', 'utf8');
const profileScreen = fs.readFileSync('src/app/profile.tsx', 'utf8');

assert.equal(supabase.includes("AppState.addEventListener('change'"), true);
assert.equal(supabase.includes('supabase.auth.startAutoRefresh()'), true);
assert.equal(supabase.includes('supabase.auth.stopAutoRefresh()'), true);
assert.equal(auth.includes('authEventVersion'), true);
assert.equal(auth.includes('PASSWORD_RECOVERY'), true);
assert.equal(auth.includes('getSession error'), true);
assert.equal(home.includes('if (authLoading) return;'), true);
assert.equal(alarms.includes('if (authLoading) return;'), true);
assert.match(auth, /const \{ error \} = await supabase\.auth\.signOut\(\)/);
assert.match(auth, /if \(error\) \{[\s\S]*throw new Error\('sign out failed'\)/);
assert.match(auth, /setSession\(null\);/);
assert.match(homeScreen, /await signOut\(\);[\s\S]*router\.replace\('\/auth\/login' as never\)/);
assert.match(homeScreen, /catch \{\s*setSignOutError\(/);
assert.match(root, /Stack\.Protected guard=\{!!session[^\n]*profile\?\.id === session\.user\.id\}>[\s\S]*<Stack\.Screen name="profile" \/>/);
assert.match(root, /Stack\.Screen name="auth"[\s\S]*Stack\.Screen name="\(app\)"[\s\S]*Stack\.Screen name="password-recovery"/);
assert.match(root, /if \(result\.success\) \{[\s\S]*PASSWORD_RECOVERY from AuthProvider/);
assert.match(authLayout, /<Stack\.Screen name="login" \/>[\s\S]*<Stack\.Screen name="callback" \/>/);
assert.match(profileScreen, /if \(router\.canGoBack\(\)\) router\.back\(\);\s*else router\.replace\('\/'\)/);

// Regression model for the root stack's guarded-first-route fallback. Normal
// session events never grant recovery; only PASSWORD_RECOVERY does.
function chooseFirstAvailableRoute(routes, enabled) {
  return routes.find((route) => enabled[route]) ?? null;
}
const routeOrder = ['auth', '(app)', 'onboarding', 'password-recovery'];
assert.equal(chooseFirstAvailableRoute(routeOrder, { auth: false, '(app)': true }), '(app)');
assert.equal(chooseFirstAvailableRoute(routeOrder, { auth: true }), 'auth');
assert.equal(chooseFirstAvailableRoute(routeOrder, { auth: false, '(app)': false, onboarding: true }), 'onboarding');
assert.equal(chooseFirstAvailableRoute(routeOrder, { auth: false, '(app)': false, onboarding: false, 'password-recovery': true }), 'password-recovery');

let recovery = false;
let recoveryUserId = null;
let activeRoute = 'auth';
function applyAuthEvent(event, sessionUserId) {
  const sessionPresent = !!sessionUserId;
  if (event === 'PASSWORD_RECOVERY' && sessionPresent) {
    recovery = true;
    recoveryUserId = sessionUserId;
  } else if (event === 'SIGNED_OUT') {
    recovery = false;
    recoveryUserId = null;
  } else if (event === 'SIGNED_IN' && recoveryUserId !== sessionUserId) {
    recovery = false;
    recoveryUserId = null;
  }
  if (event === 'SIGNED_OUT') activeRoute = 'auth';
  else if (recovery) activeRoute = 'password-recovery';
  else if (sessionPresent) activeRoute = 'dashboard';
}
applyAuthEvent('SIGNED_IN', 'user-a');
assert.equal(activeRoute, 'dashboard'); // normal login
applyAuthEvent('INITIAL_SESSION', 'user-a');
assert.equal(activeRoute, 'dashboard'); // restored session
applyAuthEvent('TOKEN_REFRESHED', 'user-a');
assert.equal(activeRoute, 'dashboard'); // refresh preserves landing
applyAuthEvent('PASSWORD_RECOVERY', 'user-a');
assert.equal(activeRoute, 'password-recovery');
applyAuthEvent('SIGNED_IN', 'user-a');
assert.equal(activeRoute, 'password-recovery'); // same-user OTP SIGNED_IN race
applyAuthEvent('TOKEN_REFRESHED', 'user-a');
assert.equal(activeRoute, 'password-recovery'); // refresh does not erase recovery
applyAuthEvent('SIGNED_IN', 'user-b');
assert.equal(activeRoute, 'dashboard'); // another user cannot inherit recovery
applyAuthEvent('PASSWORD_RECOVERY', 'user-b');
assert.equal(activeRoute, 'password-recovery');
applyAuthEvent('SIGNED_OUT', null);
assert.equal(activeRoute, 'auth'); // recovery completion/logout
applyAuthEvent('SIGNED_IN', 'user-a');
assert.equal(activeRoute, 'dashboard'); // login again
for (const event of ['INITIAL_SESSION', 'TOKEN_REFRESHED', 'SIGNED_IN', 'TOKEN_REFRESHED']) applyAuthEvent(event, 'user-a');
assert.equal(activeRoute, 'dashboard'); // repeats cannot bounce into recovery
assert.equal(profileScreen.includes('onPress={() => router.back()}'), false);

console.log('Hasil: 34 assertions lulus, 0 gagal.');
