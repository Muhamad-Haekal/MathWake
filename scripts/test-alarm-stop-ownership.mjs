import fs from 'node:fs';

const reminder = fs.readFileSync('src/app/alarm-reminder.tsx', 'utf8');
const challenge = fs.readFileSync('src/app/challenge.tsx', 'utf8');
const scheduling = fs.readFileSync('src/lib/scheduling.ts', 'utf8');
const nativeAudio = fs.readFileSync('src/lib/alarm-native.ts', 'utf8');
const nativeModule = fs.readFileSync(
  'modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/MathWakeAlarmModule.kt',
  'utf8',
);
const audio = fs.readFileSync('src/lib/alarm-audio.ts', 'utf8');
const receiver = fs.readFileSync(
  'modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/MathWakeAlarmReceiver.kt',
  'utf8',
);

let passed = 0;
function check(name, condition) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

const closeHandler = reminder.slice(
  reminder.indexOf("reminder closed; alarm remains active"),
  reminder.indexOf('</Pressable>', reminder.indexOf("reminder closed; alarm remains active")),
);
check('Tutup hanya melakukan navigasi kembali', closeHandler.includes('router.back()'));
check('Tutup tidak menghentikan audio', !closeHandler.includes('stopAlarmAudio') && !closeHandler.includes('stopNativeRing'));
check('Tutup tidak menghapus sesi', !closeHandler.includes('clearAlarmSession'));

const successBlock = challenge.slice(
  challenge.indexOf('// Only a successful completion may stop the alarm.'),
  challenge.indexOf('// Core submit logic', challenge.indexOf('// Only a successful completion may stop the alarm.')),
);
check('stop audio berada setelah validasi sukses', successBlock.includes('isSuccessfulChallenge') && successBlock.includes('stopAlarmAudio(alarmId, eventId, generation)'));
check('sesi dibersihkan setelah stop audio diminta', successBlock.indexOf('stopAlarmAudio(alarmId, eventId, generation)') < successBlock.indexOf('clearAlarmSession(eventId)'));
check('jawaban gagal tidak memanggil stop audio', !challenge.slice(challenge.indexOf('// Wrong answer.'), challenge.indexOf('const handleSubmit')).includes('stopAlarmAudio'));
check('cleanup navigasi tidak memanggil stop audio', !challenge.slice(challenge.indexOf('const handleDone'), challenge.indexOf('// Retry:')).includes('stopAlarmAudio'));

check('resync membaca alarm native yang sedang aktif', scheduling.includes('getNativeActiveAlarmId()'));
check('resync mempertahankan ringer aktif', scheduling.includes('activeNativeAlarmId !== alarmId') && scheduling.includes('preserved active ringer'));
check('cancel native tidak menghentikan service', !nativeModule.slice(nativeModule.indexOf('private fun cancelAlarmImpl'), nativeModule.indexOf('private fun dismissNotificationImpl')).includes('AlarmRingerService.stop'));
check('stop native tetap occurrence-scoped', audio.includes('stopNativeRing(eventId, generation)') && audio.includes('Call only after a successful challenge completion'));
check('ringtone source handoff tetap tidak berubah ke default diam-diam', !audio.includes("return MATHWAKE_ALARM_SOUND;\n  if (ringtone.kind === 'custom'") || audio.includes('system-ringtone-uri-unavailable'));

const ringer = fs.readFileSync(
  'modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/AlarmRingerService.kt',
  'utf8',
);
const lease = ringer.match(/MUTE_LEASE_MS = (\d+)_?(\d*)L/);
const leaseMs = lease ? Number(lease[1] + lease[2]) : 0;
const renew = audio.match(/MUTE_LEASE_RENEW_MS = (\d+)/);
const renewMs = renew ? Number(renew[1]) : Infinity;
check(
  'mute native lease kedaluwarsa hanya untuk owner saat ini',
  ringer.includes('armMuteLease(owner)') && ringer.includes('resumePlayback(owner)') &&
  ringer.includes('ownership.runIfCurrent(owner)') && ringer.includes('muteOwner != owner') && leaseMs > 0,
);
check('lease dibatalkan saat stop sukses', ringer.slice(ringer.indexOf('private fun stopRingingInternal'), ringer.indexOf('private fun releasePlayer')).includes('cancelMuteLease()'));
check('JS memperbarui lease jauh sebelum kedaluwarsa', renewMs * 3 <= leaseMs);
check('perpanjangan lease hanya dari status playing player aktif', audio.includes('if (!status.playing || activePlayers.get(eventId) !== createdPlayer) return;'));
check('mute awal tetap setelah playback benar-benar mulai', audio.indexOf('await waitForPlaybackStart(player)') < audio.indexOf('if (generation) await muteNativeRing(eventId, generation)'));
check('status native hanya true saat occurrence benar-benar ringing', nativeAudio.includes('mod.isRinging(eventId, generation)'));
check('native ringing diprioritaskan sebelum fallback JS', audio.indexOf('getNativeActiveAlarmEvent()') < audio.indexOf("await import('expo-audio')"));
check('audio lama tidak hidup kembali setelah native occurrence tidak lagi ringing', audio.includes('getNativeAlarmEvent(eventId)') && audio.includes("nativeEvent.state !== 'ringing'") && audio.includes('stale native occurrence ignored'));
check('fallback tidak memute native jika native memenangkan race', audio.includes('native ringer won playback race') && audio.includes('player.setActiveForLockScreen(false)'));
check('native menang setelah fallback JS mulai tanpa dua sumber', audio.includes('native ringer won after JS start') && audio.includes('await waitForPlaybackStart(player)'));

check(
  'service start carries occurrence identity and requires ringing ledger state',
  ringer.includes('EXTRA_EVENT_ID') && ringer.includes('EXTRA_EVENT_GENERATION') &&
  ringer.includes('storedEvent.state != AlarmEventState.RINGING'),
);
const nativeMute = ringer.slice(ringer.indexOf('fun mute(eventId'), ringer.indexOf('fun stop(eventId'));
check(
  'queued mute callback revalidates its captured owner at execution',
  nativeMute.includes('ownership.current()') && nativeMute.includes('Handler(Looper.getMainLooper()).post') &&
  nativeMute.includes('ownership.runIfCurrent(owner)') && nativeMute.includes('inst.muteInternal(owner)'),
);
const nativeStop = ringer.slice(ringer.indexOf('fun stop(eventId'), ringer.indexOf('fun isActive(alarmId'));
check(
  'queued stop callback revalidates owner and uses its service startId',
  nativeStop.includes('ownership.current()') && nativeStop.includes('ownership.runIfCurrent(owner)') &&
  nativeStop.includes('inst.stopOwned(owner)'),
);
check(
  'prepared callback verifies current lease and exact MediaPlayer instance',
  ringer.includes('playerOwner == owner && player === preparedPlayer'),
);
check(
  'MediaPlayer error callback verifies current lease and player owner before cleanup',
  ringer.includes('setOnErrorListener') && ringer.includes('ownership.runIfCurrent(owner)') &&
  ringer.includes('if (resourceOwner == owner && playerOwner == owner)'),
);
check(
  'audio focus and wake lock cleanup are associated with the event lease',
  ringer.includes('audioFocusOwner != owner') && ringer.includes('wakeLockOwner != owner') &&
  ringer.includes('private fun releaseWakeLock(owner: RingerOwnership)'),
);

check('native mute and stop require occurrence identity',
  nativeModule.includes('AsyncFunction("muteRing") { eventId: String, generation: String') &&
  nativeModule.includes('AsyncFunction("stopRing") { eventId: String, generation: String') &&
  !nativeModule.includes('AlarmRingerService.stop(alarmId)'));
check('pending reads are repeatable and acknowledgment is exact occurrence scoped',
  nativeModule.includes('PendingAlarmLedger.peek') && nativeModule.includes('ackPendingImpl(eventId, generation)') &&
  nativeModule.includes('PendingAlarmLedger.acknowledge'));
check('pending event markers use independent event keys',
  receiver.includes('pending.event.$eventId') && receiver.includes('PendingAlarmLedger.enqueue'));
check('FIFO sorts by original trigger time and expires from triggerAtMs',
  fs.readFileSync('modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/AlarmEventQueue.kt', 'utf8')
    .includes('sortedWith(compareBy<AlarmEvent> { it.triggerAtMs }.thenBy { it.eventId })') &&
  fs.readFileSync('modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/AlarmEventQueue.kt', 'utf8')
    .includes('nowMs - event.triggerAtMs >= MAX_QUEUE_AGE_MS'));
check('queued-event expiry maintenance is scheduled persistently and restored on boot',
  receiver.includes('ACTION_MAINTAIN_ALARM_QUEUE') && receiver.includes('scheduleQueueMaintenance(appCtx)') &&
  receiver.includes('setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, whenMs, pi)'));
check('notification actions carry event identity with collision-checked persisted codes',
  receiver.includes('appendQueryParameter("eventId", eventId)') && receiver.includes('stablePendingIntentRequestCode') &&
  receiver.includes('nm.notify(eventId, NOTIFICATION_ID'));
check('JS challenge routes preserve occurrence identity and reject stale native events',
  challenge.includes('const occurrenceKey = JSON.stringify([alarmId, eventId, generation])') &&
  challenge.includes('validatedOccurrenceKey === occurrenceKey') &&
  challenge.includes('event?.eventId === eventId') && challenge.includes('event.state === \'ringing\'') &&
  challenge.includes('event.generation === generation') && challenge.includes('event.alarmId === alarmId') &&
  challenge.includes('nativeOwner?.eventId === eventId') && challenge.includes('nativeOwner.generation === generation') &&
  challenge.includes('nativeOwner.alarmId === alarmId') &&
  challenge.includes('if (ownerError || !ownedAlarm || !nativeOccurrenceIsOwned)') &&
  challenge.includes(".eq('user_id', user.id)"));

console.log(`\n${passed} alarm stop-ownership checks passed.`);
