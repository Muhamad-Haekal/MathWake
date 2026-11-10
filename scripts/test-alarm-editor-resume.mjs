import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const logicSource = fs.readFileSync('src/lib/alarm-editor-draft-logic.ts', 'utf8');
const editorSource = fs.readFileSync('src/components/alarms/alarm-editor-modal.tsx', 'utf8');
const alarmsSource = fs.readFileSync('src/app/(app)/alarms.tsx', 'utf8');
const rootSource = fs.readFileSync('src/app/_layout.tsx', 'utf8');
const authSource = fs.readFileSync('src/contexts/auth-context.tsx', 'utf8');

const alarmSource = fs.readFileSync('src/lib/alarms.ts', 'utf8');
const alarmOutput = ts.transpileModule(alarmSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const alarmModule = `data:text/javascript;base64,${Buffer.from(alarmOutput).toString('base64')}`;
const resolvedLogicSource = logicSource.replace(
  "import { isSnoozeInterval, snoozeMinutesOrDefault } from '@/lib/alarms';",
  `import { isSnoozeInterval, snoozeMinutesOrDefault } from '${alarmModule}';`,
);
const { outputText } = ts.transpileModule(resolvedLogicSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const logic = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const form = {
  time: '07:35',
  title: '  Olahraga Pagi  ',
  days: [1, 3, 5],
  is_recurring: true,
  is_active: true,
  difficulty: 'sulit',
  question_count: 7,
  snooze_minutes: 20,
};
const custom = { kind: 'custom', name: 'Piano.mp3', uri: 'file:///data/user/0/mathwake/piano.mp3' };
const draft = logic.createAlarmEditorDraft({ alarmId: null, form, kind: 'custom', ringtone: custom }, 500);
const stored = JSON.stringify(draft);

// Picker result/cancel paths preserve form, selected days, configuration and route intent.
assert.strictEqual(logic.applyCustomRingtoneResult(custom, { canceled: true }), custom);
assert.deepEqual(logic.applyCustomRingtoneResult(custom, { canceled: false, uri: null }), custom);
const selected = logic.applyCustomRingtoneResult(custom, {
  canceled: false,
  name: 'New tone.ogg',
  uri: 'file:///data/user/0/mathwake/new-tone.ogg',
});
assert.deepEqual(selected, {
  kind: 'custom',
  name: 'New tone.ogg',
  uri: 'file:///data/user/0/mathwake/new-tone.ogg',
});

const restored = logic.parseAlarmEditorDraft(stored, 600);
assert.deepEqual(restored, draft);
assert.deepEqual(restored.form, form);
assert.equal(restored.form.snooze_minutes, 20);
assert.deepEqual(restored.form.days, [1, 3, 5]);
assert.equal(restored.form.title, '  Olahraga Pagi  ');
assert.deepEqual(restored.ringtone, custom);
assert.equal(restored.kind, 'custom');
const legacyForm = { ...form };
delete legacyForm.title;
delete legacyForm.snooze_minutes;
const legacyDraft = logic.parseAlarmEditorDraft(JSON.stringify({ ...draft, form: legacyForm }), 600);
assert.equal(legacyDraft.form.title, '');
assert.equal(legacyDraft.form.snooze_minutes, 10);
assert.equal(logic.parseAlarmEditorDraft(stored, 500 + logic.ALARM_EDITOR_DRAFT_MAX_AGE_MS + 1), null);
assert.equal(logic.parseAlarmEditorDraft('{broken', 600), null);
assert.notEqual(logic.alarmEditorDraftKey('user-a'), logic.alarmEditorDraftKey('user-b'));

// A restored editor resumes only from normal app entry; alarm/deep-link routes win.
assert.equal(logic.shouldResumeAlarmEditor('/'), true);
assert.equal(logic.shouldResumeAlarmEditor('/alarms'), true);
assert.equal(logic.shouldResumeAlarmEditor('/alarm-reminder'), false);
assert.equal(logic.shouldResumeAlarmEditor('/challenge'), false);
assert.match(rootSource, /loadAlarmEditorDraft\(session\.user\.id\)[\s\S]*router\.replace\('\/alarms'/);
assert.match(rootSource, /alarmDraftRestoreChecked\.current[\s\S]*isLoading[\s\S]*!session/);
assert.match(alarmsSource, /const \{ user \} = useAuth\(\)/);
assert.doesNotMatch(alarmsSource, /if \(nextState === 'active'\)[\s\S]{0,80}setEditorVisible\(false\)/);
assert.match(authSource, /getSession\(\)[\s\S]*authEventVersion === 0/);
assert.match(alarmsSource, /setRestoredDraft\(draft\);[\s\S]*setEditorVisible\(true\)/);
assert.match(alarmsSource, /draft=\{restoredDraft\}[\s\S]*onDraftChange=\{persistEditorDraft\}/);
assert.match(editorSource, /draft\?\.alarmId === \(alarm\?\.id \?\? null\) \? draft\.form/);
assert.match(editorSource, /onDraftChange\(createAlarmEditorDraft/);
assert.match(editorSource, /applyCustomRingtoneResult\(ringtone,[\s\S]*nativeResult\.uri/);
assert.match(editorSource, /applyCustomRingtoneResult\(ringtone,[\s\S]*asset\.uri/);
assert.match(editorSource, /type: 'audio\/\*',[\s\S]*copyToCacheDirectory: true/);
assert.match(editorSource, /\{visible \? <AlarmEditorContent/);

console.log('Hasil: assertion alarm editor resume lulus.');
