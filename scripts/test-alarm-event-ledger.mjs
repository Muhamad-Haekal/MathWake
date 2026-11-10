import assert from 'node:assert/strict';
import fs from 'node:fs';

const ledger = fs.readFileSync(
  'modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/AlarmEventLedger.kt',
  'utf8',
);
const receiver = fs.readFileSync(
  'modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/MathWakeAlarmReceiver.kt',
  'utf8',
);
const moduleSource = fs.readFileSync(
  'modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/MathWakeAlarmModule.kt',
  'utf8',
);

let passed = 0;
function check(name, condition) {
  assert.ok(condition, `FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

function eventId(alarmId, triggerAtMs, generation) {
  return `mw1:${Buffer.from(alarmId, 'utf8').toString('hex')}:${triggerAtMs}:${generation}`;
}

// The JS calculation checks the documented tuple shape; source checks below
// bind that shape to the actual native helper implementation.
const id1 = eventId('alarm|α', 1_800_000_000_000, 'generation-a');
const id2 = eventId('alarm|α', 1_800_000_000_000, 'generation-b');
const id3 = eventId('alarm|α', 1_800_000_300_000, 'generation-a');
check('eventId uses alarm, occurrence trigger, and generation',
  id1 !== id2 && id1 !== id3 && id1.includes(':1800000000000:'));
check('native event identity uses injective hex encoding, not hashCode',
  ledger.includes('"mw1:${hex(alarmId)}:$triggerAtMs:$generation"') &&
  ledger.includes('value.toByteArray(StandardCharsets.UTF_8)') &&
  !ledger.includes('hashCode()'));
check('same alarm can retain independent event ledger keys',
  ledger.includes('fun storageKey(eventId: String): String = "event.$eventId"') &&
  ledger.includes('fun scheduleIdentity(alarmId: String)'));

check('ledger serializes a versioned record and validates it on read',
  ledger.includes('"v2"') && ledger.includes('version == "v1"') &&
  ledger.includes('fun decode(raw: String): AlarmEvent?') && ledger.includes('fields.size != 8'));
check('Android persistence commits each event record synchronously',
  receiver.includes('store.edit().putString(alarmEventKey(eventId), value).commit()'));
check('event record carries occurrence, generation, state, session, and revision',
  ledger.includes('val triggerAtMs: Long') && ledger.includes('val generation: String') &&
  ledger.includes('val state: AlarmEventState') && ledger.includes('val sessionId: String') &&
  ledger.includes('val revision: Int'));

check('transitions validate generation and reject illegal terminal transitions',
  ledger.includes('if (current.generation != generation)') &&
  ledger.includes('target !in allowedTransitions(current.state)') &&
  ledger.includes('AlarmEventState.COMPLETED, AlarmEventState.STOPPED, AlarmEventState.EXPIRED, AlarmEventState.FAILED -> emptySet()'));
check('duplicate state transition is explicitly idempotent',
  ledger.includes('AlarmEventTransitionResult.ALREADY_IN_STATE') &&
  ledger.includes('fun ensureScheduled') && ledger.includes('Never resets an existing event'));
check('receiver rejects stale trigger or generation and duplicate fire',
  receiver.includes('requestedTrigger > 0L && requestedTrigger != record.triggerAtMs') &&
  receiver.includes('requestedGeneration != record.eventGeneration') &&
  receiver.includes('AlarmEventQueue.enqueue(eventStore'));

check('main alarm PendingIntent identity remains URI based with request code zero',
  receiver.includes('fireIntent(context, record.alarmId, record.triggerAtMs, generation)') &&
  receiver.includes('context,\n    0,\n    fireIntent('));
check('legacy schedule records remain readable without eventGeneration',
  receiver.includes('o.optString("eventGeneration", "").takeIf { it.isNotBlank() }'));
check('legacy hash PendingIntent is only looked up for cancellation during migration',
  receiver.includes('cancelLegacySystemAlarm(context, record.alarmId)') &&
  receiver.includes('alarmId.hashCode()') &&
  !receiver.includes('context,\n    record.alarmId.hashCode(),\n    fireIntent('));
check('BOOT_COMPLETED continues to reschedule main alarm records',
  receiver.includes('Intent.ACTION_BOOT_COMPLETED ->') &&
  receiver.includes('rescheduleAll(appCtx, store)') &&
  receiver.includes('setExactAlarm(context, current)'));
check('main schedule record is still keyed independently from event ledger',
  receiver.includes('fun alarmRecordKey(alarmId: String) = "alarm.$alarmId"') &&
  receiver.includes('fun alarmEventKey(eventId: String) = AlarmEventLedger.storageKey(eventId)'));
check('Timer retains its separate record key and PendingIntent action',
  receiver.includes('TIMER_RECORD_KEY = "timer.main"') &&
  receiver.includes('ACTION_FIRE_TIMER'));
check('native API exposes event read and generation-checked transitions',
  moduleSource.includes('AsyncFunction("getAlarmEvent")') &&
  moduleSource.includes('AsyncFunction("transitionAlarmEvent")'));

console.log(`\n${passed} alarm event-ledger source checks passed.`);
