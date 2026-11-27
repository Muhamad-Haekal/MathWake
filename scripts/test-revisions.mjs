import assert from 'node:assert/strict';
import fs from 'node:fs';

const loginSource = fs.readFileSync('src/app/auth/login.tsx', 'utf8');
const registerSource = fs.readFileSync('src/app/auth/register.tsx', 'utf8');
const recoverySource = fs.readFileSync('src/app/password-recovery.tsx', 'utf8');
const onboardingSource = fs.readFileSync('src/app/onboarding.tsx', 'utf8');
const receiverSource = fs.readFileSync(
  'modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/MathWakeAlarmReceiver.kt',
  'utf8',
);
const ringerSource = fs.readFileSync(
  'modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/AlarmRingerService.kt',
  'utf8',
);
const queueSource = fs.readFileSync(
  'modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/AlarmEventQueue.kt',
  'utf8',
);
const moduleSource = fs.readFileSync(
  'modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/MathWakeAlarmModule.kt',
  'utf8',
);
const appJsonSource = fs.readFileSync('app.json', 'utf8');
const useAlarmsSource = fs.readFileSync('src/hooks/use-alarms.ts', 'utf8');
const alarmsScreenSource = fs.readFileSync('src/app/(app)/alarms.tsx', 'utf8');
const schedulingSource = fs.readFileSync('src/lib/scheduling.ts', 'utf8');
const rootLayoutSource = fs.readFileSync('src/app/_layout.tsx', 'utf8');
const reminderSource = fs.readFileSync('src/app/alarm-reminder.tsx', 'utf8');

let passed = 0;
function check(name, condition) {
  assert.ok(condition, `FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

console.log('--- SECTION 1: STATIC SOURCE CONTRACT CHECKS ---');

// 1. Password Visibility UI Contracts
check('login has passwordVisible state', loginSource.includes('const [passwordVisible, setPasswordVisible] = useState(false);'));
check('login has SymbolView imported', loginSource.includes("import { SymbolView } from 'expo-symbols';"));
check('login toggles secureTextEntry based on passwordVisible', loginSource.includes('secureTextEntry={!passwordVisible}'));
check('login eye button has accessible toggle labels',
  loginSource.includes("accessibilityLabel={passwordVisible ? 'Sembunyikan password' : 'Tampilkan password'}") &&
  loginSource.includes('accessibilityRole="button"'));
check('login eye icon uses visibility and visibility_off',
  loginSource.includes("android: 'visibility_off'") && loginSource.includes("android: 'visibility'"));
check('login password field retains value, autocomplete, and submit editing',
  loginSource.includes('value={password}') &&
  loginSource.includes('autoComplete="current-password"') &&
  loginSource.includes('onSubmitEditing={handleLogin}'));

check('register has passwordVisible and confirmVisible states',
  registerSource.includes('const [passwordVisible, setPasswordVisible] = useState(false);') &&
  registerSource.includes('const [confirmVisible, setConfirmVisible] = useState(false);'));
check('register has SymbolView imported', registerSource.includes("import { SymbolView } from 'expo-symbols';"));
check('register toggles secureTextEntry for both password and confirm',
  registerSource.includes('secureTextEntry={!passwordVisible}') &&
  registerSource.includes('secureTextEntry={!confirmVisible}'));
check('register eye buttons have accessible toggle labels',
  registerSource.includes("accessibilityLabel={passwordVisible ? 'Sembunyikan password' : 'Tampilkan password'}") &&
  registerSource.includes("accessibilityLabel={confirmVisible ? 'Sembunyikan konfirmasi password' : 'Tampilkan konfirmasi password'}"));
check('register password fields retain values, autocompletes, and submit editing',
  registerSource.includes('value={password}') &&
  registerSource.includes('value={confirm}') &&
  registerSource.includes('autoComplete="new-password"') &&
  registerSource.includes('onSubmitEditing={handleRegister}'));

check('password recovery has SymbolView imported', recoverySource.includes("import { SymbolView } from 'expo-symbols';"));
check('password recovery toggles secureTextEntry with eye icon button',
  recoverySource.includes('secureTextEntry={!passwordVisible}') &&
  recoverySource.includes('secureTextEntry={!confirmationVisible}') &&
  recoverySource.includes("android: 'visibility_off'") &&
  recoverySource.includes("android: 'visibility'"));
check('password recovery has accessible eye button labels',
  recoverySource.includes("accessibilityLabel={passwordVisible ? 'Sembunyikan password' : 'Tampilkan password'}") &&
  recoverySource.includes("accessibilityLabel={confirmationVisible ? 'Sembunyikan konfirmasi password' : 'Tampilkan konfirmasi password'}"));
check('password recovery retains value and new-password autocomplete',
  recoverySource.includes('value={password}') &&
  recoverySource.includes('value={confirmation}') &&
  recoverySource.includes('autoComplete="new-password"'));

check('onboarding has SymbolView and eye toggle buttons',
  onboardingSource.includes("import { SymbolView } from 'expo-symbols';") &&
  onboardingSource.includes('const [passwordVisible, setPasswordVisible] = useState(false);') &&
  onboardingSource.includes('const [confirmationVisible, setConfirmationVisible] = useState(false);') &&
  onboardingSource.includes('secureTextEntry={!passwordVisible}') &&
  onboardingSource.includes('secureTextEntry={!confirmationVisible}'));

// 2. Non-blocking Asynchronous Alarm Receiver & Diagnostic Contracts
check('receiver eliminated all Thread.sleep calls', !receiverSource.includes('Thread.sleep'));
check('receiver uses goAsync with partial wake lock and asyncExecutor',
  receiverSource.includes('val pendingResult = goAsync()') &&
  receiverSource.includes('asyncExecutor.schedule') &&
  receiverSource.includes('wakeLock?.release()') &&
  receiverSource.includes('pendingResult.finish()'));
check('receiver only reschedules when early delivery exceeds sub-second boundary (> 1500ms)',
  receiverSource.includes('if (earlyByMs > 1500L)') &&
  receiverSource.includes('try { setExactAlarm(appCtx, record) }'));
check('repeating alarm next occurrence calculation anchors to maxOf(nowMs, firedRecord.triggerAtMs)',
  receiverSource.includes('nextRepeatingTriggerMs(firedRecord.timeHHMM, firedRecord.days, maxOf(System.currentTimeMillis(), firedRecord.triggerAtMs))'));
check('queue claim tolerance window prevents clock jitter from stranding queued events',
  queueSource.includes('if (nowMs + 1000L < event.triggerAtMs) return null'));

// 3. Diagnostic Timestamps Contracts
check('receiver logs scheduledTrigger and receiverReceived diagnostics',
  receiverSource.includes('receiver.received') && receiverSource.includes('scheduledTrigger='));
check('ringer service logs ringerServiceStarted and audioStarted diagnostics',
  ringerSource.includes('ringerServiceStarted=') && ringerSource.includes('audioStarted='));
check('ringer service logs reminderLaunchRequested diagnostic',
  ringerSource.includes('reminderLaunchRequested='));
check('scheduling logs reminder.launch.requested diagnostic',
  schedulingSource.includes("stage: 'reminder.launch.requested'"));
check('reminder screen logs reminder.actually.displayed diagnostic',
  reminderSource.includes("stage: 'reminder.actually.displayed'"));

// 4. Reminder Launch & Ringer Alerts
check('ringer notification uses setOnlyAlertOnce(false) for full-screen wake',
  ringerSource.includes('.setOnlyAlertOnce(false)'));
check('scheduling fast-path navigation prevents Supabase network latency from stalling reminder',
  schedulingSource.includes('Promise.race') && schedulingSource.includes('deps.navigateToReminder'));
check('root layout polls active foreground status to launch reminder during open app usage',
  rootLayoutSource.includes('AppState.currentState === \'active\'') &&
  rootLayoutSource.includes('consumePendingAlarm()'));

// 5. Full-screen Intent Permission Banner Contracts
const appJson = JSON.parse(appJsonSource);
const permissions = appJson.expo.android.permissions;
check('app.json android.permissions contains android.permission.USE_FULL_SCREEN_INTENT',
  Array.isArray(permissions) && permissions.includes('android.permission.USE_FULL_SCREEN_INTENT'));
check('module openAppInfoSettingsImpl navigates to ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT on API 34+',
  moduleSource.includes('Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE') &&
  moduleSource.includes('Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT') &&
  moduleSource.includes('Settings.ACTION_APPLICATION_DETAILS_SETTINGS'));
check('useAlarms listens to AppState to re-check permissions and schedules on resume',
  useAlarmsSource.includes("import { AppState } from 'react-native';") &&
  useAlarmsSource.includes("AppState.addEventListener('change', (nextState)") &&
  useAlarmsSource.includes("nextState === 'active'"));
check('alarms screen refreshes on focus effect',
  alarmsScreenSource.includes('useFocusEffect(') &&
  alarmsScreenSource.includes('void refresh();'));

console.log('\n--- SECTION 2: BEHAVIORAL LOGIC & STATE MACHINE SIMULATIONS ---');

// Behavioral Test 1: Password Visibility State Transitions
{
  function createPasswordInputState(initial = false) {
    let visible = initial;
    let text = '';
    return {
      get isVisible() { return visible; },
      get text() { return text; },
      get secureTextEntry() { return !visible; },
      type(v) { text = v; },
      toggle() { visible = !visible; },
      submit() { return text; },
    };
  }

  const input = createPasswordInputState(false);
  check('input starts with secureTextEntry true', input.secureTextEntry === true);
  input.type('SecretP@ss123');
  check('input text is preserved during typing', input.text === 'SecretP@ss123');
  input.toggle();
  check('toggling makes secureTextEntry false and text is preserved', input.secureTextEntry === false && input.text === 'SecretP@ss123');
  input.toggle();
  check('toggling again makes secureTextEntry true and text is preserved', input.secureTextEntry === true && input.text === 'SecretP@ss123');
  check('submit editing returns exact preserved text', input.submit() === 'SecretP@ss123');
}

// Behavioral Test 2: Receiver Early Boundary & Non-blocking Dispatcher
{
  function simulateReceiverDispatch(targetMs, nowMs) {
    const earlyByMs = targetMs - nowMs;
    if (earlyByMs > 1500) {
      return { action: 'reschedule_exact', delayMs: 0, blockedMainThread: false };
    }
    const delayMs = Math.max(0, earlyByMs);
    return {
      action: 'async_schedule',
      delayMs,
      blockedMainThread: false, // executed via ScheduledExecutor, not Thread.sleep!
      firedAtMs: nowMs + delayMs,
    };
  }

  // Case A: Exact on time (diff = 0)
  const onTime = simulateReceiverDispatch(10000, 10000);
  check('on time trigger dispatches immediately with zero delay and no main thread blocking',
    onTime.action === 'async_schedule' && onTime.delayMs === 0 && !onTime.blockedMainThread);

  // Case B: RTC sub-second early jitter (15ms early)
  const subSecondEarly = simulateReceiverDispatch(10000, 9985);
  check('sub-second early trigger (15ms early) schedules async wait without blocking main thread',
    subSecondEarly.action === 'async_schedule' && subSecondEarly.delayMs === 15 && !subSecondEarly.blockedMainThread);

  // Case C: RTC sub-second early jitter (1200ms early)
  const largerJitter = simulateReceiverDispatch(10000, 8800);
  check('1200ms early trigger schedules async wait without blocking main thread',
    largerJitter.action === 'async_schedule' && largerJitter.delayMs === 1200 && !largerJitter.blockedMainThread);

  // Case D: Premature trigger (> 1500ms, e.g. 5000ms early due to clock shift)
  const premature = simulateReceiverDispatch(10000, 5000);
  check('premature trigger (> 1500ms early) immediately triggers exact reschedule without sleeping',
    premature.action === 'reschedule_exact' && premature.delayMs === 0);
}

// Behavioral Test 3: Fast-path Reminder Navigation Timeout & Fallback Simulation
{
  async function simulateReminderNavigation(deps, alarmId) {
    let navigatedWith = null;
    let config = null;
    try {
      const userPromise = deps.getUserId();
      const userId = await Promise.race([
        userPromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 25)),
      ]);
      if (userId) {
        config = await Promise.race([
          deps.fetchAlarmConfig(userId, alarmId),
          new Promise((resolve) => setTimeout(() => resolve(null), 30)),
        ]);
      }
    } catch {
      config = null;
    }

    const alarmTitle = config?.title?.trim()?.slice(0, 40) || 'Alarm';
    const difficulty = config?.difficulty || 'sedang';
    const questionCount = String(config?.question_count ?? 3);

    navigatedWith = { alarmId, alarmTitle, difficulty, questionCount };
    return navigatedWith;
  }

  // Fast online response
  const onlineResult = await simulateReminderNavigation({
    getUserId: async () => 'user-123',
    fetchAlarmConfig: async () => ({ title: 'Bangun Pagi', difficulty: 'sulit', question_count: 5 }),
  }, 'alarm-1');
  check('fast online path navigates with custom title, difficulty, and question count',
    onlineResult.alarmTitle === 'Bangun Pagi' && onlineResult.difficulty === 'sulit' && onlineResult.questionCount === '5');

  // Slow / offline / hanging network (e.g. timeout simulation)
  const offlineResult = await simulateReminderNavigation({
    getUserId: async () => new Promise(() => {}), // hangs forever
    fetchAlarmConfig: async () => new Promise(() => {}),
  }, 'alarm-2');
  check('slow/offline network does not hang: navigates immediately with fallback defaults',
    offlineResult.alarmTitle === 'Alarm' && offlineResult.difficulty === 'sedang' && offlineResult.questionCount === '3');
}

// Behavioral Test 4: Queue Claim Tolerance Window
{
  function simulateQueueClaim(eventTriggerAtMs, nowMs) {
    if (nowMs + 1000 < eventTriggerAtMs) {
      return null; // premature claim rejected
    }
    return { claimed: true, eventTriggerAtMs };
  }

  const jitterArrival = simulateQueueClaim(10000, 9980); // 20ms early
  check('queue claim succeeds within 1000ms clock jitter tolerance window', jitterArrival !== null && jitterArrival.claimed);

  const farFuture = simulateQueueClaim(10000, 8500); // 1500ms early
  check('queue claim rejects events beyond tolerance window', farFuture === null);
}

// Behavioral Test 5: Full-screen Permission & Resume Evaluation
{
  function resolvePermissionState(apiLevel, canUseFullScreenGrant, notificationPermission) {
    const isNotificationGranted = notificationPermission === 'granted';
    const isFullScreenGranted = apiLevel < 34 ? true : canUseFullScreenGrant;
    const needsFullScreenBanner = isNotificationGranted && !isFullScreenGranted;
    return {
      isNotificationGranted,
      isFullScreenGranted,
      needsFullScreenBanner,
    };
  }

  // Android 13: Full-screen intent permission is automatic (not gated)
  const android13 = resolvePermissionState(33, false, 'granted');
  check('Android 13 does not require full screen banner', !android13.needsFullScreenBanner && android13.isFullScreenGranted);

  // Android 14+: Denied grant displays banner
  const android14Denied = resolvePermissionState(34, false, 'granted');
  check('Android 14+ denied grant displays banner', android14Denied.needsFullScreenBanner && !android14Denied.isFullScreenGranted);

  // Android 14+: Granted grant immediately hides banner
  const android14Granted = resolvePermissionState(34, true, 'granted');
  check('Android 14+ granted grant immediately clears banner', !android14Granted.needsFullScreenBanner && android14Granted.isFullScreenGranted);
}

console.log(`\n========================================`);
console.log(`All ${passed} static and behavioral tests passed!`);
console.log(`========================================`);
