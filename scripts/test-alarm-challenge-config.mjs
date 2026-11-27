import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const values = new Map();
globalThis.__alarmChallengeValues = values;
const storageSource = `export default {
  getItem: async (key) => globalThis.__alarmChallengeValues.get(key) ?? null,
  setItem: async (key, value) => { globalThis.__alarmChallengeValues.set(key, value); },
  removeItem: async (key) => { globalThis.__alarmChallengeValues.delete(key); },
};`;
const storageUrl = `data:text/javascript;base64,${Buffer.from(storageSource).toString('base64')}`;
const compiled = ts.transpileModule(fs.readFileSync('src/lib/alarm-challenge-config.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(
  "from '@react-native-async-storage/async-storage'",
  `from '${storageUrl}'`,
);
const config = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

await config.saveAlarmChallengeConfig({
  alarmId: 'alarm-easy-one', difficulty: 'mudah', question_count: 1, title: 'Bangun',
});
assert.deepEqual(await config.getAlarmChallengeConfig('alarm-easy-one'), {
  alarmId: 'alarm-easy-one', difficulty: 'mudah', question_count: 1, title: 'Bangun',
});

await config.cacheAlarmChallengeConfigs([
  { id: 'alarm-medium-three', difficulty: 'sedang', question_count: 3, title: 'Alarm lama' },
]);
assert.deepEqual(await config.getAlarmChallengeConfig('alarm-medium-three'), {
  alarmId: 'alarm-medium-three', difficulty: 'sedang', question_count: 3, title: 'Alarm lama',
});

await assert.rejects(config.saveAlarmChallengeConfig({
  alarmId: 'invalid', difficulty: 'invalid', question_count: 1, title: 'Invalid',
}), /tidak valid/);
assert.equal(await config.getAlarmChallengeConfig('missing'), null);

await config.removeAlarmChallengeConfig('alarm-easy-one');
assert.equal(await config.getAlarmChallengeConfig('alarm-easy-one'), null);
console.log('Alarm challenge config cache tests passed.');
