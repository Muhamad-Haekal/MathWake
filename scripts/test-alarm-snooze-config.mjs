import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAlarm, createNewAlarmForm, updateAlarm, validateAlarmForm } from '../src/lib/alarms.ts';

function fakeClient() {
  const calls = [];
  const client = {
    from(table) {
      const call = { table, payload: null, filters: [], columns: null };
      calls.push(call);
      const query = {
        insert(payload) { call.operation = 'insert'; call.payload = payload; return query; },
        update(payload) { call.operation = 'update'; call.payload = payload; return query; },
        select(columns) { call.columns = columns; return query; },
        eq(column, value) { call.filters.push([column, value]); return query; },
        single() { return Promise.resolve({ data: { id: 'alarm-1', ...call.payload }, error: null }); },
      };
      return query;
    },
  };
  return { client, calls };
}

const base = { ...createNewAlarmForm(new Date(2026, 0, 1, 5)), time: '07:00' };
for (const minutes of [5, 10, 15, 20, 30]) {
  assert.equal(validateAlarmForm({ ...base, snooze_minutes: minutes }, new Date(2026, 0, 1, 4)), null);
}
assert.match(validateAlarmForm({ ...base, snooze_minutes: 6 }, new Date(2026, 0, 1, 4)), /Snooze/);

{
  const { client, calls } = fakeClient();
  await createAlarm(client, 'user-1', { ...base, snooze_minutes: 20 });
  assert.equal(calls[0].operation, 'insert');
  assert.equal(calls[0].payload.snooze_minutes, 20);
  assert.match(calls[0].columns, /snooze_minutes/);
}
{
  const { client, calls } = fakeClient();
  await updateAlarm(client, 'user-1', 'alarm-1', { ...base, snooze_minutes: 30 });
  assert.equal(calls[0].operation, 'update');
  assert.equal(calls[0].payload.snooze_minutes, 30);
  assert.deepEqual(calls[0].filters, [['id', 'alarm-1'], ['user_id', 'user-1']]);
}

const editor = fs.readFileSync('src/components/alarms/alarm-editor-modal.tsx', 'utf8');
assert.match(editor, /snooze_minutes: snoozeMinutesOrDefault\(alarm\.snooze_minutes\)/);
assert.match(editor, /setForm\(\(current\) => \(\{ \.\.\.current, snooze_minutes: minutes \}\)\)/);
assert.match(editor, /onPress=\{onClose\}/);
const migration = fs.readFileSync('supabase/migrations/20261102000100_alarm_snooze_minutes.sql', 'utf8');
assert.match(migration, /SMALLINT NOT NULL DEFAULT 10/);
assert.match(migration, /CHECK \(snooze_minutes IN \(5, 10, 15, 20, 30\)\)/);

console.log('Hasil: konfigurasi Snooze dan CRUD test lulus.');
