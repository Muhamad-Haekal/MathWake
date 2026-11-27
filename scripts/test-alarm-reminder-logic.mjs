import assert from 'node:assert/strict';
import fs from 'node:fs';

function reminderLink(alarm) {
  return `mathwake://alarm-reminder?alarmId=${encodeURIComponent(alarm.id)}&difficulty=${encodeURIComponent(alarm.difficulty)}&questionCount=${alarm.questionCount}&timeLimitSeconds=0&maxMistakes=0`;
}

function audioSource(ringtone, systemUri = 'content://settings/alarm') {
  if (ringtone.kind === 'mathwake') return { kind: 'asset', value: 'bundled-mathwake' };
  if (ringtone.kind === 'custom' && ringtone.uri) return { kind: 'uri', value: ringtone.uri };
  if (ringtone.kind === 'system' && systemUri) return { kind: 'uri', value: systemUri };
  throw new Error('alarm-ringtone-source-unavailable');
}

function shouldCancelNativeDuringResync(engine, expired) {
  return engine === 'native' && !expired;
}

const link = reminderLink({ id: 'alarm-1', difficulty: 'sulit', questionCount: 5 });
assert.equal(link.startsWith('mathwake://alarm-reminder?'), true);
assert.equal(link.includes('mathwake://challenge'), false);
assert.equal(link.includes('alarmId=alarm-1'), true);

assert.deepEqual(audioSource({ kind: 'mathwake' }), { kind: 'asset', value: 'bundled-mathwake' });
assert.deepEqual(audioSource({ kind: 'custom', uri: 'file:///private/alarm.tone' }), { kind: 'uri', value: 'file:///private/alarm.tone' });
assert.deepEqual(audioSource({ kind: 'system' }), { kind: 'uri', value: 'content://settings/alarm' });
assert.throws(() => audioSource({ kind: 'system' }, null), /source-unavailable/);
assert.equal(shouldCancelNativeDuringResync('native', true), false);
assert.equal(shouldCancelNativeDuringResync('native', false), true);
assert.equal(shouldCancelNativeDuringResync('expo', true), false);

// Reminder presentation changes must retain occurrence validation and the
// existing audio/session handoff. Closing the screen remains navigation only.
const reminderScreen = fs.readFileSync('src/app/alarm-reminder.tsx', 'utf8');
assert.match(reminderScreen, /getNativeAlarmEvent\(eventId\)/);
assert.match(reminderScreen, /saveAlarmSession\(/);
assert.match(reminderScreen, /startAlarmAudio\(alarmId, eventId, generation\)/);
assert.match(reminderScreen, /acknowledgeNativePendingAlarm\(eventId, generation\)/);
assert.match(reminderScreen, /pathname: '\/challenge'/);
assert.match(reminderScreen, /triggerAtMs: String\(triggerAtMs\)/);
assert.match(reminderScreen, /reminder closed; alarm remains active/);
assert.doesNotMatch(reminderScreen, /stopAlarmAudio|snoozeNativeRing/);
assert.match(reminderScreen, /reminder-sunrise\.png/);
assert.match(reminderScreen, /mathwake-mark\.png/);
assert.match(reminderScreen, /Mulai tantangan/);
assert.match(reminderScreen, /Tutup reminder/);
assert.match(reminderScreen, /formatAlarmTime\(triggerAtMs\)/);

const appConfig = JSON.parse(fs.readFileSync('app.json', 'utf8')).expo;
assert.equal(appConfig.icon, './assets/images/icon.png');
assert.equal(appConfig.ios.icon, './assets/images/icon.png');
assert.equal(appConfig.android.adaptiveIcon.foregroundImage, './assets/images/android-icon-foreground.png');
assert.equal(appConfig.android.adaptiveIcon.monochromeImage, './assets/images/android-icon-monochrome.png');
assert.equal(appConfig.android.adaptiveIcon.backgroundColor, '#121212');
assert.equal(appConfig.web.favicon, './assets/images/favicon.png');
for (const asset of [
  appConfig.icon,
  appConfig.android.adaptiveIcon.foregroundImage,
  appConfig.android.adaptiveIcon.monochromeImage,
  appConfig.web.favicon,
  'assets/images/reminder-sunrise.png',
]) assert.equal(fs.existsSync(asset.replace(/^\.\//, '')), true, `${asset} exists`);

console.log('Hasil: seluruh assertion reminder lulus.');
