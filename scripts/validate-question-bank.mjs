import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildQuestionBank } from './generate-question-bank.mjs';

const sqlPath = resolve('supabase/seed/question-bank-1250.sql');
const sql = await readFile(sqlPath, 'utf8');
const expectedRows = buildQuestionBank();
const tuplePattern = /^\s+\('((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'\)(?:,)?$/gm;
const rows = [...sql.matchAll(tuplePattern)].map((match) => ({
  question: match[1].replaceAll("''", "'"),
  topic: match[2].replaceAll("''", "'"),
  difficulty: match[3].replaceAll("''", "'"),
  answer: match[4].replaceAll("''", "'"),
}));

function evaluateExpression(expression) {
  const tokens = expression.match(/\d+|[()+−×÷]/g) ?? [];
  assert.equal(tokens.join(''), expression.replaceAll(' ', ''), `Format ekspresi tidak sah: ${expression}`);
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const primary = () => {
    if (peek() === '(') {
      take();
      const value = sum();
      assert.equal(take(), ')', `Kurung tidak seimbang: ${expression}`);
      return value;
    }
    const token = take();
    assert.match(token ?? '', /^\d+$/, `Angka diharapkan: ${expression}`);
    return Number(token);
  };
  const product = () => {
    let value = primary();
    while (peek() === '×' || peek() === '÷') {
      const operator = take();
      const right = primary();
      if (operator === '×') value *= right;
      else {
        assert.notEqual(right, 0, `Pembagian dengan nol: ${expression}`);
        assert.equal(value % right, 0, `Pembagian tidak tepat: ${expression}`);
        value /= right;
      }
    }
    return value;
  };
  const sum = () => {
    let value = product();
    while (peek() === '+' || peek() === '−') {
      const operator = take();
      const right = product();
      value += operator === '+' ? right : -right;
    }
    return value;
  };
  const result = sum();
  assert.equal(index, tokens.length, `Token tersisa: ${expression}`);
  return result;
}

assert.equal(rows.length, 1250, `Jumlah baris SQL: ${rows.length}`);
assert.match(sql, /insert into public\.questions \(question_text, topic, difficulty, correct_answer\)/i);
assert.match(sql, /where not exists\s*\(/i, 'Seed harus idempotent');
assert.doesNotMatch(sql, /\b(update|delete|truncate)\s+(public\.)?questions\b/i, 'Seed tidak boleh mengubah atau menghapus data lama');

const counts = { mudah: 0, sedang: 0, sulit: 0 };
const questionSet = new Set();
for (const row of rows) {
  assert.ok(Object.hasOwn(counts, row.difficulty), `Difficulty tidak dikenal: ${row.difficulty}`);
  assert.ok(row.topic.trim(), `Topik kosong: ${row.question}`);
  assert.match(row.answer, /^[1-9]\d*$/, `Jawaban harus bilangan bulat positif: ${row.answer}`);
  assert.ok(Number.isSafeInteger(Number(row.answer)), `Jawaban di luar rentang aman: ${row.answer}`);
  const expression = row.question.replace(/\s*=\s*\?$/, '');
  assert.notEqual(expression, row.question, `Soal harus berakhir dengan = ?: ${row.question}`);
  assert.equal(evaluateExpression(expression), Number(row.answer), `Jawaban salah untuk: ${row.question}`);
  assert.ok(!questionSet.has(row.question), `Duplikasi soal: ${row.question}`);
  questionSet.add(row.question);
  counts[row.difficulty]++;
}
assert.deepEqual(counts, { mudah: 500, sedang: 500, sulit: 250 });

assert.deepEqual(rows, expectedRows, 'Isi SQL harus sama persis dengan hasil generator');
console.log(JSON.stringify({
  status: 'valid',
  total: rows.length,
  counts,
  distinctQuestions: questionSet.size,
  examples: Object.fromEntries(['mudah', 'sedang', 'sulit'].map((difficulty) => [difficulty, rows.find((row) => row.difficulty === difficulty)])),
}, null, 2));
