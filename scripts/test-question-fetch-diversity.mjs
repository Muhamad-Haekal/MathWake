import assert from 'node:assert/strict';
import { fetchQuestions, recordAttempt } from '../src/lib/questions.ts';

class MockQuery {
  constructor(client, table, columns) {
    this.client = client;
    this.table = table;
    this.columns = columns;
    this.filters = {};
    this.topicFilter = null;
    this.page = null;
    this.limitCount = null;
  }

  eq(column, value) { this.filters[column] = value; return this; }
  in(column, values) { if (column === 'topic') this.topicFilter = values; return this; }
  order(column, options) { this.orderBy = [column, options]; return this; }
  range(from, to) { this.page = [from, to]; return this; }
  limit(value) { this.limitCount = value; return this; }

  then(resolve, reject) {
    try {
      const call = {
        table: this.table,
        columns: this.columns,
        filters: { ...this.filters },
        topicFilter: this.topicFilter,
        page: this.page,
        limitCount: this.limitCount,
        orderBy: this.orderBy,
      };
      this.client.calls.push(call);
      const failure = this.client.failTables.has(this.table);
      if (failure) return Promise.resolve({ data: null, error: { message: `${this.table} unavailable` } }).then(resolve, reject);

      let rows = [...(this.client.tables[this.table] ?? [])];
      rows = rows.filter((row) => Object.entries(this.filters).every(([key, value]) => row[key] === value));
      if (this.topicFilter) rows = rows.filter((row) => this.topicFilter.includes(row.topic));
      if (this.orderBy) rows.sort((a, b) => String(a[this.orderBy[0]]).localeCompare(String(b[this.orderBy[0]])));
      if (this.page) rows = rows.slice(this.page[0], this.page[1] + 1);
      else if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    } catch (error) {
      return Promise.reject(error).then(resolve, reject);
    }
  }
}

class MockSupabase {
  constructor(questions, attempts = [], failTables = []) {
    this.tables = { questions, attempts };
    this.failTables = new Set(failTables);
    this.calls = [];
  }
  from(table) {
    return {
      select: (columns) => new MockQuery(this, table, columns),
      insert: async (row) => {
        if (this.failTables.has(table)) return { data: null, error: { message: `${table} insert unavailable` } };
        this.tables[table].push({ id: `insert-${this.tables[table].length}`, ...row });
        return { data: null, error: null };
      },
    };
  }
}

const mediumPool = Array.from({ length: 500 }, (_, index) => ({
  id: `q-${String(index).padStart(4, '0')}`,
  difficulty: 'sedang',
  topic: index % 2 ? 'Aljabar' : 'Aritmetika',
  question_text: `Soal sedang ${index} = ?`,
  correct_answer: String(index + 1),
}));
let mediumPoolCoverage = 0;

function ids(result) { return result.questions.map((question) => question.id); }
function assertSessionUnique(result) {
  assert.equal(new Set(ids(result)).size, result.questions.length, 'Question ID tidak boleh berulang dalam satu sesi');
}

// Entire 500-row Medium pool is sampled over repeated sessions, not a fixed
// count*4 prefix. This also exercises the actual Fisher-Yates implementation.
{
  const db = new MockSupabase(mediumPool);
  const observed = new Set();
  for (let session = 0; session < 600; session++) {
    const result = await fetchQuestions(db, { difficulty: 'sedang', count: 20, userId: 'user-a' });
    assertSessionUnique(result);
    assert.equal(result.questions.length, 20);
    for (const id of ids(result)) observed.add(id);
  }
  assert.ok(observed.size >= 490, `Seluruh pool Medium harus terjangkau, hanya ${observed.size}/500 terpilih`);
  mediumPoolCoverage = observed.size;
  const questionQueries = db.calls.filter((call) => call.table === 'questions');
  assert.deepEqual(
    questionQueries.slice(0, 6).map((call) => call.page),
    [[0, 99], [100, 199], [200, 299], [300, 399], [400, 499], [500, 599]],
    'Pagination harus membaca keseluruhan pool Medium sebelum randomisasi',
  );
  assert.ok(questionQueries.every((call) => call.orderBy?.[0] === 'id'));
}

// Previously attempted questions are deprioritized, using user-scoped attempt
// history keyed on question_text (the current schema has no question_id).
{
  const attempts = mediumPool.slice(0, 450).map((question, index) => ({
    id: `attempt-${String(index).padStart(4, '0')}`,
    user_id: 'user-a',
    difficulty: 'sedang',
    question_text: question.question_text,
  }));
  const db = new MockSupabase(mediumPool, attempts);
  const result = await fetchQuestions(db, { difficulty: 'sedang', count: 20, userId: 'user-a' });
  assertSessionUnique(result);
  assert.ok(result.questions.every((question) => Number(question.id.slice(2)) >= 450), 'Soal yang belum pernah dikerjakan harus didahulukan');
  const historyQuery = db.calls.find((call) => call.table === 'attempts');
  assert.equal(historyQuery.filters.user_id, 'user-a', 'Riwayat harus dibatasi pada pengguna aktif');
  assert.equal(historyQuery.filters.difficulty, 'sedang', 'Riwayat hanya dibaca untuk level yang dipilih');
}

// The existing attempt writer persists the question text that the history
// reader uses, scoped to the same user, without requiring a schema change.
{
  const db = new MockSupabase(mediumPool);
  const question = {
    id: mediumPool[12].id,
    difficulty: 'sedang',
    topic: mediumPool[12].topic,
    question_text: mediumPool[12].question_text,
    answer: mediumPool[12].correct_answer,
    options: null,
  };
  await recordAttempt(db, {
    userId: 'user-a', alarmId: null, question,
    userAnswer: question.answer, isCorrect: true, timeTakenMs: 700,
  });
  assert.equal(db.tables.attempts[0].user_id, 'user-a');
  assert.equal(db.tables.attempts[0].question_text, question.question_text);
  const result = await fetchQuestions(db, { difficulty: 'sedang', count: 20, userId: 'user-a' });
  assert.ok(!ids(result).includes(question.id), 'Question yang tersimpan sebagai attempt harus dihindari saat masih ada soal baru');
}

// The in-memory guard prevents a just-answered question from repeating even
// when the async insert has not reached the database or the history read fails.
{
  const db = new MockSupabase(mediumPool, [], ['attempts']);
  const question = {
    id: mediumPool[27].id,
    difficulty: 'sedang',
    topic: mediumPool[27].topic,
    question_text: mediumPool[27].question_text,
    answer: mediumPool[27].correct_answer,
    options: null,
  };
  await recordAttempt(db, {
    userId: 'user-race-test', alarmId: null, question,
    userAnswer: question.answer, isCorrect: true, timeTakenMs: 500,
  });
  const result = await fetchQuestions(db, { difficulty: 'sedang', count: 20, userId: 'user-race-test' });
  assert.ok(!ids(result).includes(question.id), 'Cache proses harus mengecualikan attempt terbaru pada kegagalan DB');
  assertSessionUnique(result);
}

// When only ten unseen questions remain, all ten are used first and the rest
// of the session is filled from the shuffled seen pool without duplicates.
{
  const attempts = mediumPool.slice(0, 490).map((question, index) => ({
    id: `attempt-${String(index).padStart(4, '0')}`,
    user_id: 'user-a',
    difficulty: 'sedang',
    question_text: question.question_text,
  }));
  const db = new MockSupabase(mediumPool, attempts);
  const result = await fetchQuestions(db, { difficulty: 'sedang', count: 20, userId: 'user-a' });
  assert.equal(result.questions.length, 20);
  assertSessionUnique(result);
  assert.equal(result.questions.filter((question) => Number(question.id.slice(2)) >= 490).length, 10);
}

// History pages beyond 1,000 attempts are read, while duplicate past attempts
// simply collapse into a text set.
{
  const attempts = Array.from({ length: 1000 }, (_, index) => ({
    id: `attempt-${String(index).padStart(4, '0')}`,
    user_id: 'user-a',
    difficulty: 'sedang',
    question_text: mediumPool[0].question_text,
  }));
  attempts.push(...mediumPool.slice(0, 450).map((question, index) => ({
    id: `attempt-${String(1000 + index).padStart(4, '0')}`,
    user_id: 'user-a',
    difficulty: 'sedang',
    question_text: question.question_text,
  })));
  const db = new MockSupabase(mediumPool, attempts);
  const result = await fetchQuestions(db, { difficulty: 'sedang', count: 20, userId: 'user-a' });
  assertSessionUnique(result);
  assert.ok(result.questions.every((question) => Number(question.id.slice(2)) >= 450));
  const pages = db.calls.filter((call) => call.table === 'attempts').map((call) => call.page);
  assert.deepEqual(pages, [[0, 999], [1000, 1999]]);
}

// If RLS prevents reading history, serving questions still works. Topic and
// difficulty filters remain honored by the question query.
{
  const db = new MockSupabase(mediumPool, [], ['attempts']);
  const result = await fetchQuestions(db, {
    difficulty: 'sedang', topics: ['Aritmetika'], count: 20, userId: 'user-a',
  });
  assert.equal(result.questions.length, 20);
  assertSessionUnique(result);
  assert.ok(result.questions.every((question) => question.topic === 'Aritmetika'));
  assert.equal(result.shortfall, 'none');
}

console.log(`Hasil: variasi Medium ${mediumPoolCoverage}/500 muncul dalam 600 sesi simulasi; anti-duplikasi sesi, prioritas riwayat, pagination, fallback, dan filter (lulus).`);
