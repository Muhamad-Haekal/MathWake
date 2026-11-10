import assert from 'node:assert/strict';

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

console.log('Hasil: 10 lolos, 0 gagal.');
