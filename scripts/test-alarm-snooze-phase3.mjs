import assert from 'node:assert/strict';
import fs from 'node:fs';

const challenge = fs.readFileSync('src/app/challenge.tsx', 'utf8');
const alarmNative = fs.readFileSync('src/lib/alarm-native.ts', 'utf8');
const scheduling = fs.readFileSync('src/lib/scheduling.ts', 'utf8');
const receiver = fs.readFileSync('modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/MathWakeAlarmReceiver.kt', 'utf8');
const service = fs.readFileSync('modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/AlarmRingerService.kt', 'utf8');
const module = fs.readFileSync('modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/MathWakeAlarmModule.kt', 'utf8');
const nativeModule = fs.readFileSync('modules/mathwake-alarm/src/NativeMathWakeAlarm.ts', 'utf8');
const ledger = fs.readFileSync('modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/AlarmEventLedger.kt', 'utf8');
const coordinator = fs.readFileSync('modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/AlarmSnoozeCoordinator.kt', 'utf8');
const coordinatorTests = fs.readFileSync('modules/mathwake-alarm/android/src/test/java/expo/modules/mathwakealarm/AlarmSnoozeCoordinatorTest.kt', 'utf8');

const challengeSnooze = challenge.match(/const handleSnooze = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[/)?.[1];
assert.ok(challengeSnooze, 'challenge Snooze handler exists');
assert.match(challenge, /select\('id,snooze_minutes'\)/);
assert.match(challengeSnooze, /snoozeNativeRing\(alarmId, eventId, generation, snoozeMinutes\)/);
assert.match(challengeSnooze, /event\.state !== 'ringing'[\s\S]*owner\.eventId !== eventId/);
assert.ok(challengeSnooze.indexOf('await snoozeNativeRing') < challengeSnooze.indexOf('if (!result?.success)'));
const failureStart = challengeSnooze.indexOf('if (!result?.success)');
const successSettle = challengeSnooze.indexOf("\n      settleInactiveOccurrence('snoozed');\n    } finally", failureStart);
assert.ok(failureStart >= 0 && successSettle > failureStart);
assert.doesNotMatch(challengeSnooze.slice(failureStart, successSettle), /stopAlarmAudio/);
assert.match(challengeSnooze, /latest\?\.state === 'ringing' && latestOwner\?\.eventId === eventId[\s\S]*'Snooze gagal\. Alarm masih berbunyi/);
assert.match(challengeSnooze, /snoozeBusyRef\.current/);
assert.match(challenge, /event\.state === 'snoozed'[\s\S]*settleInactiveOccurrence\('snoozed'\)/);
assert.match(challenge, /occurrenceInactiveRef\.current \|\|/);
assert.match(challenge, /stopAlarmAudio\(alarmId, eventId, generation\)/);

assert.match(alarmNative, /snoozeMinutesOrDefault\(alarm\.snooze_minutes\)/);
assert.match(alarmNative, /mod\.snoozeRing\(alarmId, eventId, generation, intervalMinutes\)/);
assert.match(scheduling, /scheduleNativeAlarm\(alarm, when\)/);
assert.match(nativeModule, /snoozeMinutes: number/);
assert.match(nativeModule, /scheduleAlarmWithSnooze\?: \(options: NativeAlarmScheduleOptions\)/);
assert.match(alarmNative, /mod\.scheduleAlarmWithSnooze!\(options\)/);
assert.match(alarmNative, /snoozeMinutesOrDefault\(alarm\.snooze_minutes\)/);
assert.match(scheduling, /updateNativeAlarmSnoozeMinutes\(alarm\.id, alarm\.snooze_minutes \?\? 10\)/);
assert.match(module, /AsyncFunction\("updateAlarmSnoozeMinutes"\)/);
assert.match(module, /record\.copy\(snoozeMinutes = snoozeMinutes\), synchronous = true/);

assert.match(receiver, /ACTION_NOTIFICATION_SNOOZE -> handleNotificationSnooze\(appCtx, intent\)/);
assert.match(receiver, /notificationSnoozeIntent\(context: Context, event: AlarmEvent, intervalMinutes: Int\)/);
for (const extra of ['EXTRA_ALARM_ID', 'EXTRA_EVENT_ID', 'EXTRA_EVENT_GENERATION', 'EXTRA_SNOOZE_MINUTES']) {
  assert.ok(receiver.includes(`putExtra(${extra},`), `notification action carries ${extra}`);
}
assert.match(receiver, /notificationSnoozeIdentity\(event\.eventId\)/);
assert.match(receiver, /stablePendingIntentRequestCode\(context, "notification-snooze:\$\{event\.eventId\}"\)/);
assert.match(receiver, /source\.snoozeMinutes != intervalMinutes/);
assert.match(receiver, /AlarmSnoozeCoordinator\.snooze\(/);
assert.match(receiver, /ACTION_BOOT_COMPLETED[\s\S]*restoreSnoozeSchedules\(appCtx, store\)/);
assert.doesNotMatch(receiver.match(/private fun handleNotificationSnooze\([\s\S]*?\n  \}/)?.[0] ?? '', /JavaScript|snoozeNativeRing/);
assert.match(service, /builder\.addAction\([\s\S]*notificationSnoozePendingIntent\(context, snoozeTarget, interval\)/);
assert.match(service, /it\.state == AlarmEventState\.RINGING/);
assert.match(module, /snoozeRingingOccurrence\(context, alarmId, eventId, generation, intervalMinutes\)/);
assert.match(module, /private fun stopOccurrence\([\s\S]*AlarmEventState\.RINGING[\s\S]*AlarmRingerService\.stop/);
assert.match(module, /AsyncFunction\("stopRing"\)[\s\S]*stopOccurrence\(eventId, generation\)/);
assert.match(module, /hasOtherLiveAlarmOccurrence[\s\S]*AlarmEventState\.SCHEDULED, AlarmEventState\.QUEUED, AlarmEventState\.RINGING/);
assert.doesNotMatch(module.match(/AsyncFunction\("hasOtherLiveAlarmOccurrence"\)[\s\S]*?\n    \}/)?.[0] ?? '', /AlarmEventState\.SNOOZED/);
assert.match(ledger, /fun notificationSnoozeIdentity\(eventId: String\)/);
assert.match(coordinator, /schedule\(child\)[\s\S]*transitionToSnoozed[\s\S]*runCatching\(stop\)/);
assert.match(coordinatorTests, /stoppedOccurrenceCannotBeSnoozed/);
assert.match(coordinatorTests, /stopAndSnoozeAreSerializedAndOnlyOneCanOwnTheTransition/);
assert.match(coordinatorTests, /mainRecurringScheduleRemainsUntouched/);

console.log('Hasil: Phase 3 Snooze challenge/native notification assertions lulus.');
