import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  clearTimerState,
  createTimerState,
  getTimerRemainingMs,
  loadTimerState,
  pauseTimer,
  resetTimer,
  restoreTimerState,
  resumeTimer,
  saveTimerState,
  settleTimer,
  startTimer,
} from '../src/lib/timer.ts';
import {
  clearStopwatchState,
  createStopwatchState,
  getStopwatchElapsedMs,
  loadStopwatchState,
  pauseStopwatch,
  recordStopwatchLap,
  resetStopwatch,
  resumeStopwatch,
  saveStopwatchState,
  startStopwatch,
} from '../src/lib/stopwatch.ts';

class MemoryStorage {
  values = new Map();
  async getItem(key) { return this.values.get(key) ?? null; }
  async setItem(key, value) { this.values.set(key, value); }
  async removeItem(key) { this.values.delete(key); }
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`PASS: ${name}`);
}

const t0 = 1_000_000;
let timer = createTimerState(10_000);
await check('timer start sets deadline', () => {
  timer = startTimer(timer, t0);
  assert.deepEqual(timer, {
    status: 'running', durationMs: 10_000, remainingMs: 10_000,
    deadlineMs: t0 + 10_000, finishedAtMs: null,
  });
});
await check('timer remaining comes from deadline', () => assert.equal(getTimerRemainingMs(timer, t0 + 2_500), 7_500));
await check('timer pause stores remaining', () => {
  timer = pauseTimer(timer, t0 + 2_500);
  assert.equal(timer.status, 'paused');
  assert.equal(timer.remainingMs, 7_500);
  assert.equal(timer.deadlineMs, null);
});
await check('timer resume creates a new deadline', () => {
  timer = resumeTimer(timer, t0 + 5_000);
  assert.equal(timer.status, 'running');
  assert.equal(timer.deadlineMs, t0 + 12_500);
});
await check('timer deadline is inclusive at exact boundary', () => {
  const finished = settleTimer(timer, t0 + 12_500);
  assert.equal(finished.status, 'finished');
  assert.equal(finished.remainingMs, 0);
  assert.equal(finished.finishedAtMs, t0 + 12_500);
  assert.deepEqual(settleTimer(finished, t0 + 20_000), finished);
});
await check('timer reset returns idle', () => {
  timer = resetTimer(timer);
  assert.deepEqual(timer, {
    status: 'idle', durationMs: 10_000, remainingMs: 10_000,
    deadlineMs: null, finishedAtMs: null,
  });
});
await check('expired timer restores as finished', () => {
  const restored = restoreTimerState(startTimer(createTimerState(500), 1000), 1500);
  assert.equal(restored?.status, 'finished');
  assert.equal(restored?.finishedAtMs, 1500);
});
await check('timer persistence round-trips and clears', async () => {
  const storage = new MemoryStorage();
  const state = startTimer(createTimerState(2_000), 5_000);
  await saveTimerState(state, storage);
  assert.equal((await loadTimerState(storage, 5_500))?.remainingMs, 1_500);
  await clearTimerState(storage);
  assert.equal(await loadTimerState(storage, 5_500), null);
});
await check('invalid timer persistence is rejected', async () => {
  const storage = new MemoryStorage();
  await storage.setItem('mathwake:timer-state', JSON.stringify({ status: 'running', durationMs: 0 }));
  assert.equal(await loadTimerState(storage, 0), null);
});

let stopwatch = createStopwatchState();
await check('stopwatch start and elapsed time', () => {
  stopwatch = startStopwatch(stopwatch, t0);
  assert.equal(getStopwatchElapsedMs(stopwatch, t0 + 3_250), 3_250);
});
await check('stopwatch pause freezes accumulated time', () => {
  stopwatch = pauseStopwatch(stopwatch, t0 + 3_250);
  assert.deepEqual({ status: stopwatch.status, accumulatedMs: stopwatch.accumulatedMs, startedAtMs: stopwatch.startedAtMs }, {
    status: 'paused', accumulatedMs: 3_250, startedAtMs: null,
  });
});
await check('stopwatch resume continues from accumulated time', () => {
  stopwatch = resumeStopwatch(stopwatch, t0 + 10_000);
  assert.equal(getStopwatchElapsedMs(stopwatch, t0 + 11_500), 4_750);
});
await check('stopwatch lap stores cumulative and split elapsed time', () => {
  stopwatch = recordStopwatchLap(stopwatch, t0 + 12_000);
  stopwatch = recordStopwatchLap(stopwatch, t0 + 14_500);
  assert.deepEqual(stopwatch.laps.map(({ elapsedMs, lapMs }) => ({ elapsedMs, lapMs })), [
    { elapsedMs: 5_250, lapMs: 5_250 },
    { elapsedMs: 7_750, lapMs: 2_500 },
  ]);
});
await check('stopwatch reset clears elapsed and laps', () => {
  stopwatch = resetStopwatch();
  assert.deepEqual(stopwatch, { status: 'idle', accumulatedMs: 0, startedAtMs: null, laps: [] });
});
await check('stopwatch persistence restores running timestamps', async () => {
  const storage = new MemoryStorage();
  let state = startStopwatch(createStopwatchState(), 100);
  state = pauseStopwatch(state, 600);
  await saveStopwatchState(state, storage);
  const restored = await loadStopwatchState(storage);
  assert.equal(restored?.accumulatedMs, 500);
  assert.equal(getStopwatchElapsedMs(restored, 1_000), 500);
  await clearStopwatchState(storage);
  assert.equal(await loadStopwatchState(storage), null);
});
await check('stopwatch timestamp boundary does not produce negative time', () => {
  const state = startStopwatch(createStopwatchState(), 1_000);
  assert.equal(getStopwatchElapsedMs(state, 999), 0);
});

await check('Timer dan Stopwatch terdaftar sebagai tab dan route', () => {
  const tabs = fs.readFileSync('src/components/app-tabs.tsx', 'utf8');
  const timerScreen = fs.readFileSync('src/app/(app)/timer.tsx', 'utf8');
  const stopwatchScreen = fs.readFileSync('src/app/(app)/stopwatch.tsx', 'utf8');
  assert.match(tabs, /name="timer"/);
  assert.match(tabs, /name="stopwatch"/);
  assert.match(timerScreen, /loadTimerState/);
  assert.match(timerScreen, /setInterval\(tick, 250\)/);
  assert.match(stopwatchScreen, /loadStopwatchState/);
  assert.match(stopwatchScreen, /setInterval\(\(\) => setNowMs\(Date\.now\(\)\), 250\)/);
  assert.doesNotMatch(timerScreen, /scheduleNotification|startAlarmAudio/);
  assert.doesNotMatch(stopwatchScreen, /scheduleNotification|startAlarmAudio/);
});

await check('Timer native memakai kontrak terpisah dari alarm', () => {
  const timerScreen = fs.readFileSync('src/app/(app)/timer.tsx', 'utf8');
  const adapter = fs.readFileSync('src/lib/timer-native.ts', 'utf8');
  const module = fs.readFileSync('modules/mathwake-alarm/src/NativeMathWakeAlarm.ts', 'utf8');
  const receiver = fs.readFileSync(
    'modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/MathWakeAlarmReceiver.kt',
    'utf8',
  );
  assert.match(adapter, /scheduleTimer/);
  assert.match(adapter, /cancelTimer/);
  assert.doesNotMatch(adapter, /scheduleAlarm|cancelAlarm|stopRing|muteRing/);
  assert.match(module, /scheduleTimer/);
  assert.match(module, /cancelTimer/);
  assert.match(receiver, /ACTION_FIRE_TIMER/);
  assert.match(receiver, /TIMER_RECORD_KEY = "timer\.main"/);
  assert.match(receiver, /CHANNEL_ID_TIMER = "mathwake-timer"/);
  assert.match(receiver, /TIMER_NOTIFICATION_ID = 1002/);
  assert.match(receiver, /firedDeadline.*record\.deadlineAtMs/);
  assert.match(receiver, /record\.deadlineAtMs <= 0L/);
  assert.match(receiver, /System\.currentTimeMillis\(\) < record\.deadlineAtMs/);
  assert.match(receiver, /scheduleTimerSystem\(appCtx, record\.deadlineAtMs\)/);
  assert.match(timerScreen, /ensureSchedulePermission/);
  assert.match(timerScreen, /notificationPermissionRequested/);
  assert.match(receiver, /deleteTimerRecord\(store\)\s*\n\s*try \{ showTimerNotification/);
  assert.match(receiver, /setExactAndAllowWhileIdle/);
  assert.match(receiver, /setAndAllowWhileIdle/);
  assert.match(receiver, /rescheduleTimer/);
});

console.log(`\nHasil: ${passed} checks lulus, 0 gagal.`);
