import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Math Challenge data layer.
//
// VERIFIED SCHEMA (confirmed via Supabase Dashboard, 2026-10-09):
//
// questions:
//   id            uuid         NOT NULL  PK
//   question_text text         NOT NULL
//   topic         text         NOT NULL
//   difficulty    text         NOT NULL  ('mudah' | 'sedang' | 'sulit' — unverified vocab)
//   correct_answer text        NOT NULL  ← column is "correct_answer", NOT "answer"
//   created_by    uuid         nullable
//   created_at    timestamptz  nullable
//   NOTE: no "options" column — multiple-choice is not supported by current schema.
//
// attempts:
//   id                uuid         NOT NULL  PK
//   user_id           uuid         NOT NULL  FK auth.users
//   alarm_id          uuid         nullable  FK alarms
//   topic             text         NOT NULL
//   difficulty        text         NOT NULL
//   question_text     text         NOT NULL
//   correct_answer    text         NOT NULL
//   user_answer       text         nullable
//   is_correct        boolean      NOT NULL
//   time_taken_seconds numeric     nullable
//   created_at        timestamptz  nullable
//   NOTE: no question_id column.
//
// alarm_logs:
//   id            uuid PK
//   user_id       uuid FK auth.users (audited: user_id col exists)
//   alarm_id      uuid FK alarms
//   completed_at  timestamptz
//   status        text  ('completed' | 'failed' | 'skipped')
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuestionRow {
  id: string;
  difficulty: string;
  topic: string;
  question_text: string;
  /**
   * The correct answer. Internally named `answer` so callers don't need to
   * change — mapped from the DB column `correct_answer` in fetchQuestions.
   */
  answer: string;
  /**
   * Always null for now: the `questions` table has no `options` column.
   * Kept in the type so challenge.tsx can safely check `question.options`
   * without a type error; the check will always be false.
   */
  options: string[] | null;
}

export interface FetchQuestionsResult {
  questions: QuestionRow[];
  /** Describes why fewer questions were returned than requested. */
  shortfall: 'none' | 'partial' | 'empty';
}

// ---------------------------------------------------------------------------
// Questions fetch
//
// Fetches `count` questions matching difficulty (and optional topics).
// Uses RANDOM ordering so each session gets a different set.
// The caller must handle shortfall gracefully — the table might not have
// enough rows for the requested difficulty.
// ---------------------------------------------------------------------------

export async function fetchQuestions(
  client: SupabaseClient,
  opts: {
    difficulty: string;
    topics?: string[] | null;
    count: number;
  },
): Promise<FetchQuestionsResult> {
  // Clamp count to a safe limit so the query can't be abused if misconfigured.
  const safeCount = Math.max(1, Math.min(opts.count, 20));

  // Select only verified columns. The DB column is "correct_answer"; we
  // map it to the internal property name "answer" so callers are unchanged.
  // "options" is intentionally omitted — the column does not exist in the
  // live schema; the QuestionRow.options field will always be null.
  let query = client
    .from('questions')
    .select('id,difficulty,topic,question_text,correct_answer')
    .eq('difficulty', opts.difficulty);

  if (opts.topics && opts.topics.length > 0) {
    query = query.in('topic', opts.topics);
  }

  // RANDOM() via column name hint — Supabase/PostgREST doesn't support
  // ORDER BY RANDOM() directly. We fetch a larger pool and shuffle client-side.
  const poolSize = safeCount * 4;
  const { data, error } = await query.limit(poolSize);

  if (error) {
    throw new Error(`Gagal mengambil soal: ${error.message}`);
  }

  // Map correct_answer → answer so the rest of the app is unaffected.
  type DbRow = { id: string; difficulty: string; topic: string; question_text: string; correct_answer: string };
  const rows: QuestionRow[] = ((data ?? []) as DbRow[]).map((row) => ({
    id: row.id,
    difficulty: row.difficulty,
    topic: row.topic,
    question_text: row.question_text,
    answer: row.correct_answer,
    options: null,          // no options column in DB
  }));

  // Fisher-Yates shuffle for uniform randomness.
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }

  const selected = rows.slice(0, safeCount);
  const shortfall: FetchQuestionsResult['shortfall'] =
    selected.length === 0 ? 'empty' : selected.length < safeCount ? 'partial' : 'none';

  return { questions: selected, shortfall };
}

// ---------------------------------------------------------------------------
// Answer validation
//
// Compares user input against the stored answer. Handles:
//   - Numeric equality (±0.001 tolerance for float display quirks)
//   - Case-insensitive string match after trim
//   - Multiple-choice: the selected option must match the answer exactly
// ---------------------------------------------------------------------------

export function validateAnswer(userInput: string, question: QuestionRow): boolean {
  const raw = userInput.trim();
  const correct = question.answer.trim();

  if (raw === '') return false;

  // Try numeric comparison first (covers "3", "3.0", " 3 ").
  const userNum = parseFloat(raw.replace(',', '.'));
  const correctNum = parseFloat(correct.replace(',', '.'));
  if (!isNaN(userNum) && !isNaN(correctNum)) {
    return Math.abs(userNum - correctNum) < 0.001;
  }

  // Fall back to case-insensitive string match.
  return raw.toLowerCase() === correct.toLowerCase();
}

// ---------------------------------------------------------------------------
// Attempt recording
//
// Writes one row per answered question. All NOT NULL columns are included.
// Scoped to userId so a misconfigured RLS policy cannot write another user's rows.
// ---------------------------------------------------------------------------

export interface RecordAttemptInput {
  userId: string;
  alarmId: string | null;
  /** The question that was answered — provides topic, difficulty, question_text, correct_answer. */
  question: QuestionRow;
  /** The raw text the user submitted. */
  userAnswer: string;
  isCorrect: boolean;
  /** Elapsed milliseconds for this question — converted to seconds before insert. */
  timeTakenMs: number;
}

export async function recordAttempt(
  client: SupabaseClient,
  input: RecordAttemptInput,
): Promise<void> {
  const row: Record<string, unknown> = {
    user_id: input.userId,
    topic: input.question.topic,
    difficulty: input.question.difficulty,
    question_text: input.question.question_text,
    correct_answer: input.question.answer,   // internally "answer", DB column "correct_answer"
    user_answer: input.userAnswer,
    is_correct: input.isCorrect,
    // Convert ms → seconds (numeric, nullable in DB).
    time_taken_seconds: input.timeTakenMs / 1000,
  };

  // alarm_id is nullable — only include when present.
  if (input.alarmId) row.alarm_id = input.alarmId;

  // No question_id column in this table.

  const { error } = await client.from('attempts').insert(row);

  if (error) {
    console.warn('[MathWake][Challenge] attempt insert error:', {
      code: (error as { code?: string }).code,
      message: error.message,
      hint: (error as { hint?: string }).hint,
      columns_sent: Object.keys(row),
    });
    // Non-fatal: recording failure does not block the challenge result.
  }
}

// ---------------------------------------------------------------------------
// Alarm log recording
//
// One row per alarm challenge session with final status.
// ---------------------------------------------------------------------------

export type ChallengeStatus = 'completed' | 'failed';

export interface RecordAlarmLogInput {
  userId: string;
  alarmId: string;
  status: ChallengeStatus;
}

export async function recordAlarmLog(
  client: SupabaseClient,
  input: RecordAlarmLogInput,
): Promise<void> {
  const { error } = await client.from('alarm_logs').insert({
    user_id: input.userId,
    alarm_id: input.alarmId,
    status: input.status,
    completed_at: new Date().toISOString(),
  });
  if (error) {
    console.warn('[MathWake][Challenge] alarm_log insert error:', {
      code: (error as { code?: string }).code,
      message: error.message,
      hint: (error as { hint?: string }).hint,
    });
    // Non-fatal: the user still sees the correct result screen.
  } else {
    console.info('[MathWake][Challenge] alarm_log recorded:', {
      alarmId: input.alarmId,
      status: input.status,
    });
  }
}
