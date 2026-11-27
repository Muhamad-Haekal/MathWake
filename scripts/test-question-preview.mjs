import assert from 'node:assert/strict';
import { buildQuestionBank } from './generate-question-bank.mjs';
import { getChallengeQuestionPreview } from '../src/lib/question-preview.ts';

const bank = buildQuestionBank();
const levels = ['mudah', 'sedang', 'sulit'];
const previews = Object.fromEntries(levels.map((level) => [level, getChallengeQuestionPreview(level)]));

assert.deepEqual(
  Object.keys(previews),
  levels,
  'Preview tersedia untuk setiap level dan dapat dipilih ulang secara dinamis',
);

for (const level of levels) {
  const preview = previews[level];
  assert.ok(preview.description.length > 0, `Deskripsi ${level} harus tersedia`);
  assert.equal(preview.examples.length, 3, `Harus ada tiga contoh ${level}`);
  assert.ok(new Set(preview.examples).size === preview.examples.length, `Contoh ${level} tidak boleh duplikat`);
  for (const example of preview.examples) {
    assert.ok(example.endsWith('= ?'), `Contoh tidak boleh menyertakan jawaban: ${example}`);
    assert.ok(
      bank.some((row) => row.difficulty === level && row.question === example),
      `Contoh harus cocok dengan bank ${level}: ${example}`,
    );
  }
}

assert.notEqual(previews.mudah.description, previews.sedang.description);
assert.notEqual(previews.sedang.description, previews.sulit.description);
assert.notDeepEqual(previews.mudah.examples, previews.sedang.examples);
assert.notDeepEqual(previews.sedang.examples, previews.sulit.examples);
assert.equal(getChallengeQuestionPreview('mudah'), previews.mudah, 'Mengganti level kembali harus langsung memilih preview Mudah');

console.log('Hasil: preview dinamis untuk tiga level, tanpa jawaban, cocok dengan bank soal aktual (lulus).');
