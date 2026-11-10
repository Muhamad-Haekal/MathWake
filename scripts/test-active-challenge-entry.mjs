import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function transpile(source) {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const activeStateJs = transpile(fs.readFileSync('src/lib/alarm-active-state.ts', 'utf8'));
const entryJs = transpile(fs.readFileSync('src/lib/active-challenge-entry.ts', 'utf8'))
  .replace("from './alarm-active-state'", `from 'data:text/javascript;base64,${Buffer.from(activeStateJs).toString('base64')}'`);
const entry = await import(`data:text/javascript;base64,${Buffer.from(entryJs).toString('base64')}`);

const nowMs = 1_800_000_000_000;
const session = (alarmId, eventId, generation, age = 1000) => ({
  alarmId, eventId, generation, triggerAtMs: nowMs - age,
  difficulty: 'sulit', questionCount: 8, timeLimitSeconds: 45, maxMistakes: 2,
  startedAt: nowMs - age,
});
const nativeEvent = {
  alarmId: 'alarm-a', eventId: 'mw1:event-a', generation: 'generation-a',
  triggerAtMs: nowMs - 500, state: 'ringing',
};
const nativeOwner = { alarmId: 'alarm-a', eventId: nativeEvent.eventId, generation: nativeEvent.generation };

const nativeOccurrence = entry.resolveActiveChallengeOccurrence({
  alarmId: 'alarm-a', nativeActiveId: 'alarm-a', nativeOwner, nativeEvent,
  session: null, jsAudioPlaying: false, nowMs,
});
assert.deepEqual(nativeOccurrence, {
  alarmId: 'alarm-a', eventId: 'mw1:event-a', generation: 'generation-a', triggerAtMs: nowMs - 500,
});
assert.ok(entry.resolveActiveChallengeOccurrence({
  alarmId: 'alarm-a', nativeActiveId: 'alarm-a', nativeOwner, nativeEvent,
  session: null, jsAudioPlaying: false, nowMs, scheduleActive: false,
}), 'a fired one-time alarm remains challengeable after its schedule is disabled');
assert.ok(entry.resolveActiveChallengeOccurrence({
  alarmId: 'alarm-a', nativeActiveId: 'alarm-a', nativeOwner: { ...nativeOwner, eventId: 'mw1:recurring-event' }, nativeEvent: { ...nativeEvent, eventId: 'mw1:recurring-event' },
  session: null, jsAudioPlaying: false, nowMs, scheduleActive: true,
}), 'a recurring alarm can open its ringing occurrence');
assert.equal(entry.resolveActiveChallengeOccurrence({
  alarmId: 'alarm-a', nativeActiveId: 'alarm-b', nativeOwner, nativeEvent,
  session: session('alarm-a', 'expo:event-a', 'generation-a'), jsAudioPlaying: true, nowMs,
}), null, 'a different native owner must not fall through to a JS session');
assert.equal(entry.resolveActiveChallengeOccurrence({
  alarmId: 'alarm-a', nativeActiveId: 'alarm-a', nativeOwner, nativeEvent: { ...nativeEvent, state: 'completed' },
  session: null, jsAudioPlaying: false, nowMs,
}), null, 'a terminal native event cannot reopen');
assert.equal(entry.resolveActiveChallengeOccurrence({
  alarmId: 'alarm-a', nativeActiveId: 'alarm-a', nativeOwner, nativeEvent: { ...nativeEvent, state: 'stopped' },
  session: null, jsAudioPlaying: false, nowMs,
}), null, 'a stopped occurrence cannot open');
assert.equal(entry.resolveActiveChallengeOccurrence({
  alarmId: 'alarm-a', nativeActiveId: 'alarm-a', nativeOwner, nativeEvent: { ...nativeEvent, state: 'completed' },
  session: null, jsAudioPlaying: false, nowMs,
}), null, 'a completed occurrence cannot create another session');
assert.equal(entry.resolveActiveChallengeOccurrence({
  alarmId: 'alarm-a', nativeActiveId: 'alarm-a', nativeOwner, nativeEvent: { ...nativeEvent, eventId: 'mw1:old-event' },
  session: null, jsAudioPlaying: false, nowMs,
}), null, 'the active ID cannot authorize a different event');
assert.equal(entry.resolveActiveChallengeOccurrence({
  alarmId: 'alarm-a', nativeActiveId: 'alarm-a', nativeOwner, nativeEvent: { ...nativeEvent, generation: 'old-generation' },
  session: null, jsAudioPlaying: false, nowMs,
}), null, 'a stale generation cannot open');

const jsSession = session('alarm-a', 'expo:event-a', 'generation-a');
assert.deepEqual(entry.resolveActiveChallengeOccurrence({
  alarmId: 'alarm-a', nativeActiveId: null, nativeOwner: null, nativeEvent: null,
  session: jsSession, jsAudioPlaying: false, nowMs,
}), {
  alarmId: 'alarm-a', eventId: 'expo:event-a', generation: 'generation-a', triggerAtMs: nowMs - 1000,
});
assert.equal(entry.resolveActiveChallengeOccurrence({
  alarmId: 'alarm-a', nativeActiveId: null, nativeOwner: null, nativeEvent: null,
  session: session('alarm-a', 'expo:stale', 'generation-a', 3_600_001), jsAudioPlaying: false, nowMs,
}), null, 'stale session without live audio is rejected');
assert.equal(entry.resolveActiveChallengeOccurrence({
  alarmId: 'alarm-a', nativeActiveId: null, nativeOwner: null, nativeEvent: null,
  session: session('alarm-a', 'mw1:old-event', 'generation-a'), jsAudioPlaying: false, nowMs,
}), null, 'a persisted native session after JS restart requires live native ownership');
assert.deepEqual(entry.resolveActiveChallengeOccurrence({
  alarmId: 'alarm-a', nativeActiveId: 'alarm-a', nativeOwner, nativeEvent,
  session: session('alarm-a', nativeEvent.eventId, nativeEvent.generation), jsAudioPlaying: false, nowMs,
}), nativeOccurrence, 'a session restored after JS restart reuses the native occurrence identity');

const params = entry.buildActiveChallengeParams(nativeOccurrence, {
  title: '  Meeting  ', difficulty: 'sulit', questionCount: 12, timeLimitSeconds: 45, maxMistakes: 2,
});
assert.equal(params.alarmId, 'alarm-a');
assert.equal(params.eventId, 'mw1:event-a');
assert.equal(params.generation, 'generation-a');
assert.equal(params.alarmTitle, 'Meeting');
assert.equal(params.questionCount, '10');
assert.equal(params.timeLimitSeconds, '45');
assert.equal(params.maxMistakes, '2');
assert.deepEqual(entry.buildActiveChallengeParams(nativeOccurrence, {
  title: '  Meeting  ', difficulty: 'sulit', questionCount: 12, timeLimitSeconds: 45, maxMistakes: 2,
}), params, 'repeat taps keep the same occurrence identity and title');
assert.equal(entry.buildActiveChallengeParams(nativeOccurrence, {}).alarmTitle, 'Alarm');

const home = fs.readFileSync('src/app/(app)/index.tsx', 'utf8');
const card = fs.readFileSync('src/components/home/next-alarm-card.tsx', 'utf8');
const challenge = fs.readFileSync('src/app/challenge.tsx', 'utf8');
const alarmSession = fs.readFileSync('src/lib/alarm-session.ts', 'utf8');
const rootLayout = fs.readFileSync('src/app/_layout.tsx', 'utf8');
assert.match(home, /\.eq\('user_id', user\.id\)[\s\S]*maybeSingle\(\)/);
assert.doesNotMatch(home, /row\.is_active !== true/);
assert.match(home, /\.eq\('user_id', user\.id\)/);
assert.match(home, /if \(!row\) throw new Error/);
assert.match(home, /openingChallengeRef\.current/);
assert.match(home, /setOpeningChallenge\(true\)/);
assert.match(home, /Konfigurasi alarm tidak dapat dimuat/);
assert.match(home, /latest\.occurrence\.eventId !== first\.occurrence\.eventId/);
assert.match(home, /router\.replace\([\s\S]*pathname: '\/challenge'/);
assert.match(card, /onPress=\{onContinue\}[\s\S]*disabled=\{openingChallenge\}/);
assert.match(challenge, /alarmId: alarmId \?\? '',[\s\S]*alarmTitle,[\s\S]*eventId,[\s\S]*generation,[\s\S]*triggerAtMs: String\(triggerAtMs\)/);
assert.match(challenge, /getNativeActiveAlarmEvent/);
assert.match(challenge, /nativeOwner\?\.eventId === eventId/);
assert.match(challenge, /\.eq\('user_id', user\.id\)/);
assert.match(home, /openingChallengeRef\.current/);
assert.match(alarmSession, /AsyncStorage\.setItem\(KEY, JSON\.stringify\(session\)\)/);
assert.match(home, /getAlarmSession\(\)/);
assert.match(rootLayout, /consumePendingAlarmToReminder/);

console.log('Hasil: validasi occurrence, parameter rute, fallback judul, auth, busy-state, dan retry lulus.');
