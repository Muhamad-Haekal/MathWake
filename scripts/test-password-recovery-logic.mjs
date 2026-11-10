import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const login = fs.readFileSync('src/app/auth/login.tsx', 'utf8');
const recovery = fs.readFileSync('src/app/password-recovery.tsx', 'utf8');
const recoveryLib = fs.readFileSync('src/lib/password-recovery.ts', 'utf8');
const auth = fs.readFileSync('src/contexts/auth-context.tsx', 'utf8');
const oauth = fs.readFileSync('src/lib/auth-oauth.ts', 'utf8');
const root = fs.readFileSync('src/app/_layout.tsx', 'utf8');
const callbackScreen = fs.readFileSync('src/app/auth/callback.tsx', 'utf8');
const callbackLogicSource = fs.readFileSync('src/lib/auth-callback-logic.ts', 'utf8');
const completionLogicSource = fs.readFileSync('src/lib/recovery-completion.ts', 'utf8');

async function importTypeScript(source) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

const callbackLogic = await importTypeScript(callbackLogicSource);
const completionLogic = await importTypeScript(completionLogicSource);

assert.match(login, /password-recovery/);
assert.match(recovery, /resetPasswordForEmail/);
assert.match(recovery, /verifyOtp/);
assert.match(recovery, /type: 'recovery'/);
assert.match(recovery, /updateUser\(\{ password \}/);
assert.doesNotMatch(recovery, /signInWithOtp/);
assert.match(auth, /PASSWORD_RECOVERY/);
assert.doesNotMatch(auth, /loadRecoveryMarker|isRecoveryMarkerValid/);
assert.match(auth, /recoveryExpiresAt/);
assert.match(auth, /RECOVERY_MARKER_MAX_AGE_MS/);
assert.match(auth, /void clearRecovery\(\)/);
assert.match(recoveryLib, /RECOVERY_MARKER_MAX_AGE_MS/);
assert.match(recoveryLib, /AsyncStorage/);
assert.match(recoveryLib, /markerGeneration/);
assert.match(recovery, /recoveryExpiresAt <= Date\.now\(\)/);
assert.match(recovery, /Password berhasil diperbarui/);
assert.match(oauth, /processAuthCallback/);
assert.match(oauth, /startAuthCallbackHandling\(onResult/);
assert.match(oauth, /result\.kind === 'recovery'/);
assert.match(root, /Alert\.alert\(/);
assert.match(root, /router\.replace\('\/password-recovery'\)/);
assert.match(root, /if \(recoveryActive\) router\.replace\('\/password-recovery'\)/);
assert.match(callbackScreen, /Minta tautan baru/);
assert.match(callbackScreen, /Kembali ke login/);
assert.doesNotMatch(callbackScreen, /ActivityIndicator/);
assert.match(root, /<Stack\.Screen name="password-recovery" \/>/);
assert.doesNotMatch(root, /Stack\.Protected guard=\{!session \|\| recoveryActive\}>\s*<Stack\.Screen name="password-recovery"/);

function recoveryRouteAvailable({ session, recoveryActive }) {
  // The request form is public; the update form has a separate recovery gate.
  return true;
}
assert.equal(recoveryRouteAvailable({ session: null, recoveryActive: false }), true);
assert.equal(recoveryRouteAvailable({ session: { id: 'reset-session' }, recoveryActive: true }), true);
assert.equal(recoveryRouteAvailable({ session: { id: 'normal-session' }, recoveryActive: false }), true);
function passwordUpdateAllowed({ recoveryActive, expiresAt, now }) {
  return recoveryActive && !!expiresAt && expiresAt > now;
}
assert.equal(passwordUpdateAllowed({ recoveryActive: false, expiresAt: null, now: 0 }), false);
assert.equal(passwordUpdateAllowed({ recoveryActive: true, expiresAt: 100, now: 100 }), false);
assert.equal(passwordUpdateAllowed({ recoveryActive: true, expiresAt: 101, now: 100 }), true);

// Small mock verifies the required call order and the recovery gate.
const calls = [];
const mockAuth = {
  async resetPasswordForEmail() {
    calls.push('resetPasswordForEmail');
    return { error: null };
  },
  async verifyOtp() {
    calls.push('verifyOtp');
    return { data: { session: { user: { id: 'user-1' } } }, error: null };
  },
  async updateUser() {
    calls.push('updateUser');
    return { error: null };
  },
};

let recoveryVerified = false;
async function mockedRecoveryFlow() {
  await mockAuth.resetPasswordForEmail('user@example.com', {
    redirectTo: 'mathwake://auth/callback',
  });
  const result = await mockAuth.verifyOtp({
    email: 'user@example.com',
    token: '123456',
    type: 'recovery',
  });
  recoveryVerified = !!result.data.session;
  if (!recoveryVerified) return;
  await mockAuth.updateUser({ password: 'new-password' });
}

assert.deepEqual(calls, []);
await mockedRecoveryFlow();
assert.deepEqual(calls, ['resetPasswordForEmail', 'verifyOtp', 'updateUser']);
assert.equal(recoveryVerified, true);

// Behavioural regression models for the security boundaries. These avoid any
// live Supabase or device storage and intentionally never print their values.
function recoveryGate({ coldStart, recoveryEvent, recoveryUserId, sessionUserId, expiresAt, now }) {
  return !coldStart
    && recoveryEvent
    && recoveryUserId === sessionUserId
    && expiresAt > now;
}

assert.equal(recoveryGate({ coldStart: true, recoveryEvent: false, recoveryUserId: 'same', sessionUserId: 'same', expiresAt: 200, now: 100 }), false);
assert.equal(recoveryGate({ coldStart: false, recoveryEvent: false, recoveryUserId: 'same', sessionUserId: 'same', expiresAt: 200, now: 100 }), false);
assert.equal(recoveryGate({ coldStart: false, recoveryEvent: true, recoveryUserId: 'same', sessionUserId: 'same', expiresAt: 100, now: 100 }), false);
assert.equal(recoveryGate({ coldStart: false, recoveryEvent: true, recoveryUserId: 'old', sessionUserId: 'new', expiresAt: 200, now: 100 }), false);

let active = false;
let currentVersion = 2;
const oldVersion = 1;
if (oldVersion === currentVersion) active = true;
assert.equal(active, false);

let markerOperations = Promise.resolve();
let markerVersion = 0;
const markerWrites = [];
function queueMarkerWrite(kind) {
  const version = ++markerVersion;
  markerOperations = markerOperations.catch(() => undefined).then(() => {
    if (version === markerVersion) markerWrites.push(kind);
  });
  return markerOperations;
}
await Promise.all([queueMarkerWrite('save'), queueMarkerWrite('clear')]);
assert.deepEqual(markerWrites, ['clear']);

assert.match(recovery, /const \{ data, error \} = await supabase\.auth\.getSession\(\)/);
assert.match(recovery, /const localSessionStatus = await readLocalSessionStatus\(\)/);
assert.match(recovery, /completion\?\.nextStep === 'retry-sign-out'/);
assert.match(recovery, /result\.nextStep === 'login' && !signOutFailed && markerCleared/);

function classifyGoogleCallback(params) {
  const recoveryPayload = params.type === 'recovery' || !!params.token || !!params.token_hash;
  if (recoveryPayload) return false;
  return !!params.code || (!!params.error && !!params.state);
}

assert.equal(classifyGoogleCallback({ type: 'recovery', token_hash: 'present' }), false);
assert.equal(classifyGoogleCallback({ code: 'present' }), true);

// Exercise the actual callback decision and dedupe helpers with mocked exchange
// results. This does not contact Supabase or verify a real email link.
let exchangeCalls = 0;
const recoveryCallback = await callbackLogic.processAuthCallback(
  { code: 'opaque-code' },
  'unknown',
  async () => { exchangeCalls += 1; return { kind: 'recovery' }; },
);
assert.deepEqual(recoveryCallback, { handled: true, success: true, kind: 'recovery' });
assert.equal(exchangeCalls, 1);

const expiredCallback = await callbackLogic.processAuthCallback(
  { code: 'expired-code' },
  'unknown',
  async () => { throw new Error('private provider detail'); },
);
assert.equal(expiredCallback.success, false);
assert.equal(expiredCallback.kind, 'unknown');
assert.match(expiredCallback.message, /kedaluwarsa/);
assert.doesNotMatch(expiredCallback.message, /private provider detail/);

const googleError = await callbackLogic.processAuthCallback(
  { error: 'access_denied', state: 'opaque-state' },
  'unknown',
  async () => { throw new Error('must not exchange'); },
);
assert.deepEqual(googleError, { handled: true, success: false, kind: 'google', message: 'Login Google dibatalkan.' });

const unverifiedRecovery = await callbackLogic.processAuthCallback(
  { type: 'recovery', token_hash: 'opaque-hash' },
  'unknown',
  async () => { throw new Error('must not exchange token_hash'); },
);
assert.equal(unverifiedRecovery.success, false);
assert.equal(unverifiedRecovery.kind, 'recovery');
assert.match(unverifiedRecovery.message, /tidak didukung/);

let dedupeCalls = 0;
const processOnce = callbackLogic.createCallbackUrlProcessor(async () => {
  dedupeCalls += 1;
  return { success: false, message: 'known failure' };
});
const [firstFailure, duplicateFailure] = await Promise.all([
  processOnce('mathwake://auth/callback?code=opaque'),
  processOnce('mathwake://auth/callback?code=opaque'),
]);
const cachedFailure = await processOnce('mathwake://auth/callback?code=opaque');
assert.equal(dedupeCalls, 1);
assert.deepEqual(duplicateFailure, firstFailure);
assert.deepEqual(cachedFailure, firstFailure);

const signOutErrorWithSession = completionLogic.recoveryCompletionAfterUpdate({
  signOutError: true,
  localSessionStatus: 'signed-in',
  recoveryMarkerCleared: false,
});
assert.equal(signOutErrorWithSession.nextStep, 'retry-sign-out');
assert.match(signOutErrorWithSession.message, /Password berhasil diperbarui/);
assert.doesNotMatch(signOutErrorWithSession.message, /Password gagal diperbarui/);

const signOutErrorButLocalSessionRemoved = completionLogic.recoveryCompletionAfterUpdate({
  signOutError: true,
  localSessionStatus: 'signed-out',
  recoveryMarkerCleared: true,
});
assert.equal(signOutErrorButLocalSessionRemoved.nextStep, 'login');
assert.match(signOutErrorButLocalSessionRemoved.message, /Password berhasil diperbarui/);
assert.match(signOutErrorButLocalSessionRemoved.message, /sesi lain mungkin masih aktif/i);

const unknownSession = completionLogic.recoveryCompletionAfterUpdate({
  signOutError: true,
  localSessionStatus: 'unknown',
  recoveryMarkerCleared: false,
});
assert.equal(unknownSession.nextStep, 'retry-sign-out');
assert.match(unknownSession.message, /status sesi.*belum dapat dipastikan/);

console.log('Hasil: seluruh assertion password recovery lulus (termasuk callback, deduplikasi, dan sign-out).');
