import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIFFICULTIES = ['mudah', 'sedang', 'sulit'];
const add = (rows, difficulty, topic, expression, answer) => {
  rows.push({ difficulty, topic, question: `${expression} = ?`, answer: String(answer) });
};

export function buildQuestionBank() {
  const rows = [];

  // Easy: one operation, familiar numbers. Each category contributes 125 items.
  for (let i = 0; i < 125; i++) {
    const a = 1 + i % 25, b = 1 + Math.floor(i / 25);
    add(rows, 'mudah', 'Penjumlahan', `${a} + ${b}`, a + b);

    const minuend = 10 + i % 25, subtrahend = 1 + Math.floor(i / 25);
    add(rows, 'mudah', 'Pengurangan', `${minuend} − ${subtrahend}`, minuend - subtrahend);

    const factorA = 2 + i % 11, factorB = 2 + Math.floor(i / 11);
    add(rows, 'mudah', 'Perkalian', `${factorA} × ${factorB}`, factorA * factorB);

    const divisor = 2 + i % 12, quotient = 2 + Math.floor(i / 12);
    add(rows, 'mudah', 'Pembagian', `${divisor * quotient} ÷ ${divisor}`, quotient);
  }

  // Medium: two operations with a clear order of operations and positive integer results.
  for (let i = 0; i < 100; i++) {
    const a = 80 + 3 * i, b = 35 + (7 * i) % 80, c = 10 + i % 25;
    add(rows, 'sedang', 'Tambah dan kurang', `${a} + ${b} − ${c}`, a + b - c);

    const x = 12 + i % 39, y = 8 + Math.floor(i / 20), z = 15 + (11 * i) % 90;
    add(rows, 'sedang', 'Kali lalu tambah', `${x} × ${y} + ${z}`, x * y + z);

    const d = 2 + i % 11, q = 30 + i, r = 12 + (13 * i) % 75;
    add(rows, 'sedang', 'Bagi lalu tambah', `${d * q} ÷ ${d} + ${r}`, q + r);

    const divisor = 2 + i % 9, quotient = 15 + i, remainder = 10 + (7 * i) % 60;
    add(rows, 'sedang', 'Tambah lalu bagi', `(${divisor * quotient} + ${divisor * remainder}) ÷ ${divisor}`, quotient + remainder);

    const factor = 3 + i % 12, multiplier = 5 + Math.floor(i / 12), divisor2 = 2 + i % 5;
    const product = factor * multiplier * divisor2, extra = 25 + (9 * i) % 75;
    add(rows, 'sedang', 'Pembagian dan penjumlahan', `${product} ÷ ${divisor2} + ${extra}`, factor * multiplier + extra);
  }

  // Hard: three operations, larger but still manageable whole-number arithmetic.
  for (let i = 0; i < 50; i++) {
    const a = 25 + 3 * i, b = 12 + i % 19, c = 20 + (7 * i) % 60, d = 5 + i % 14;
    add(rows, 'sulit', 'Operasi campuran', `${a} × ${b} + ${c} − ${d}`, a * b + c - d);

    const x = 20 + i, y = 15 + i % 12, z = 3 + i % 9, w = 10 + i % 17;
    add(rows, 'sulit', 'Kurung, kali, kurang', `(${x} + ${y}) × ${z} − ${w}`, (x + y) * z - w);

    const divisor = 3 + i % 10, quotient = 20 + 2 * i, addend = 30 + (9 * i) % 80;
    add(rows, 'sulit', 'Bagi, tambah, kali', `${divisor * quotient} ÷ ${divisor} + ${addend} × 2`, quotient + addend * 2);

    const e = 2 + i % 9, multiple = 12 + i, factor = 3 + i % 8, addend2 = 20 + (5 * i) % 70;
    add(rows, 'sulit', 'Kurung, kali, bagi', `(${e * multiple} + ${e * factor}) ÷ ${e} × 2 + ${addend2}`, (multiple + factor) * 2 + addend2);

    const m = 25 + 2 * i, n = 18 + i % 14, p = 10 + (3 * i) % 35, q = 2 + i % 4, r = 35 + i;
    add(rows, 'sulit', 'Dua perkalian dan tambah', `${m} × ${n} − ${p} × ${q} + ${r}`, m * n - p * q + r);
  }

  const counts = Object.fromEntries(DIFFICULTIES.map((difficulty) => [difficulty, rows.filter((row) => row.difficulty === difficulty).length]));
  if (rows.length !== 1250 || counts.mudah !== 500 || counts.sedang !== 500 || counts.sulit !== 250) {
    throw new Error(`Jumlah bank soal tidak sesuai: ${JSON.stringify(counts)}`);
  }
  return rows;
}

const quote = (value) => `'${value.replaceAll("'", "''")}'`;
export function renderSeedSql(rows = buildQuestionBank()) {
  const values = rows.map((row) => `  (${quote(row.question)}, ${quote(row.topic)}, ${quote(row.difficulty)}, ${quote(row.answer)})`).join(',\n');
  return `-- Additive, idempotent import. Existing questions are never updated or deleted.\ninsert into public.questions (question_text, topic, difficulty, correct_answer)\nselect v.question_text, v.topic, v.difficulty, v.correct_answer\nfrom (values\n${values}\n) as v(question_text, topic, difficulty, correct_answer)\nwhere not exists (\n  select 1 from public.questions q\n  where q.question_text = v.question_text\n    and q.topic = v.topic\n    and q.difficulty = v.difficulty\n    and q.correct_answer = v.correct_answer\n);\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const rows = buildQuestionBank();
  const target = resolve(process.argv[2] ?? 'supabase/seed/question-bank-1250.sql');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, renderSeedSql(rows), 'utf8');
  console.log(JSON.stringify({ target, total: rows.length, counts: Object.fromEntries(DIFFICULTIES.map((d) => [d, rows.filter((r) => r.difficulty === d).length])) }, null, 2));
}
