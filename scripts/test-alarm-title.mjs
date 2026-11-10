import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync('src/lib/alarms.ts', 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const alarms = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

assert.equal(alarms.normalizeAlarmTitle('  Bangun Kuliah  '), 'Bangun Kuliah');
assert.equal(alarms.normalizeAlarmTitle(' \t '), 'Alarm');
assert.equal(alarms.normalizeAlarmTitle(undefined), 'Alarm');
assert.equal(alarms.createNewAlarmForm().title, '');

let operation = null;
const mockClient = {
  from(table) {
    assert.equal(table, 'alarms');
    return {
      insert(payload) { operation = { kind: 'insert', payload }; return this; },
      update(payload) { operation = { kind: 'update', payload }; return this; },
      select() { return this; },
      eq() { return this; },
      single: async () => ({ data: { ...operation.payload, id: 'alarm-a' }, error: null }),
    };
  },
};
const validForm = { ...alarms.createNewAlarmForm(new Date(2026, 0, 1, 5, 0)), is_recurring: true, days: [1, 2, 3, 4, 5] };
await alarms.createAlarm(mockClient, 'user-a', { ...validForm, title: '  Kuliah  ' });
assert.equal(operation.kind, 'insert');
assert.equal(operation.payload.title, 'Kuliah');
await alarms.createAlarm(mockClient, 'user-a', validForm);
assert.equal(operation.payload.title, 'Alarm');
await alarms.updateAlarm(mockClient, 'user-a', 'alarm-a', { ...validForm, title: '  Meeting  ' });
assert.equal(operation.kind, 'update');
assert.equal(operation.payload.title, 'Meeting');

const editor = fs.readFileSync('src/components/alarms/alarm-editor-modal.tsx', 'utf8');
const alarmNative = fs.readFileSync('src/lib/alarm-native.ts', 'utf8');
const scheduling = fs.readFileSync('src/lib/scheduling.ts', 'utf8');
const layout = fs.readFileSync('src/app/_layout.tsx', 'utf8');
const reminder = fs.readFileSync('src/app/alarm-reminder.tsx', 'utf8');
const challenge = fs.readFileSync('src/app/challenge.tsx', 'utf8');
const nativeRecord = fs.readFileSync('modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/MathWakeAlarmReceiver.kt', 'utf8');
const nativeRinger = fs.readFileSync('modules/mathwake-alarm/android/src/main/java/expo/modules/mathwakealarm/AlarmRingerService.kt', 'utf8');

assert.match(editor, /maxLength=\{40\}/);
assert.match(editor, /title: typeof alarm\.title === 'string'/);
assert.match(alarmNative, /alarmTitle=\$\{encodeURIComponent\(title\)\}/);
assert.match(scheduling, /title: alarmTitle/);
assert.match(layout, /select\('difficulty,question_count,title'\)/);
assert.match(reminder, /\{alarmTitle\}/);
assert.match(challenge, /\{alarmTitle\}/);
assert.match(nativeRecord, /\.put\("title", normalizeAlarmTitle\(record\.title\)\)/);
assert.match(nativeRecord, /o\.optString\("title", "Alarm"\)/);
assert.match(nativeRecord, /alarmRecordKey\(record\.alarmId\)/);
assert.match(nativeRinger, /setContentTitle\(normalizeAlarmTitle\(record\.title\)\)/);

console.log('Hasil: assertion judul alarm lulus.');
