/**
 * Uji mesin status tantangan (pure, tanpa React/RN).
 *
 * Mengimpor reducer aktual dari src/lib/challenge-state.ts via strip-tipe
 * Node (Node 22.18+; `import type` dihapus saat runtime, jadi tidak ada
 * dependensi native).
 *
 * Persetujuan kunci Phase 1:
 *   - Keberhasilan VALID hanya ketika SETIAP soal dijawab benar
 *     (correctCount === total) DAN fase berakhir sebagai 'completed'.
 *   - Jawaban salah, retry yang kehabisan kesempatan (maksa pindah soal),
 *     dan jawaban salah pada soal TERAKHIR selalu berujung 'failed' —
 *     audio alarm TIDAK dihentikan, alarm satu kali TIDAK dinonaktifkan.
 *   - Retry dalam soal yang sama (salah sekali-dua kali lalu benar) tetap
 *     sah: soal dianggap terjawab benar.
 *
 * Cara pakai:  node scripts/test-challenge-logic.mjs
 */
import {
  getFinishedStatus,
  initialState,
  isSuccessfulChallenge,
  reducer,
  WRONGS_BEFORE_ADVANCE,
} from '../src/lib/challenge-state.ts';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`GAGAL: ${name}\n  aktual:   ${a}\n  ekspektasi: ${e}`);
  }
}

// --- DSL rinci ---

function question(id, answer = '42') {
  return {
    id,
    difficulty: 'sedang',
    topic: 'aritmatika',
    question_text: `${id}: 5 + ${id}?`,
    answer,
    options: null,
  };
}

function start(questions) {
  return reducer(initialState(), { type: 'LOAD_SUCCESS', questions });
}

/** Jawaban benar → pindah soal (CORRECT_ANSWER diikuti NEXT_QUESTION). */
function right(state) {
  let s = reducer(state, { type: 'CORRECT_ANSWER', timeTakenMs: 1000 });
  return reducer(s, { type: 'NEXT_QUESTION' });
}

/** Salah satu kali (tidak pindah soal — retry dalam soal yang sama). */
function wrongStay(state) {
  return reducer(state, { type: 'WRONG_ANSWER', timeTakenMs: 1000 });
}

/**
 * Salah `times` kali lalu dipaksa pindah soal (WRONG_ANSWER berulang diikuti
 * NEXT_QUESTION). Memodelkan kehabisan kesempatan (WRONGS_BEFORE_ADVANCE).
 */
function wrongSkip(state, times = WRONGS_BEFORE_ADVANCE) {
  let s = state;
  for (let i = 0; i < times; i += 1) {
    s = reducer(s, { type: 'WRONG_ANSWER', timeTakenMs: 1000 });
  }
  return reducer(s, { type: 'NEXT_QUESTION' });
}

function describe(state) {
  if (state.phase.kind !== 'finished') {
    return { finished: false, phase: state.phase.kind };
  }
  return {
    finished: true,
    status: state.phase.status,
    correct: state.phase.correctCount,
    total: state.questions.length,
    succeeded: isSuccessfulChallenge(
      state.phase.status,
      state.phase.correctCount,
      state.questions.length,
    ),
  };
}

const tiga = () => [question('q1'), question('q2'), question('q3')];
const satu = () => [question('q1')];

// --- 1. Semua benar → keberhasilan valid (audio STOP, alarm nonaktif) ---
{
  let s = start(tiga());
  s = right(s);
  s = right(s);
  s = right(s);
  check('semua benar → completed 3/3', describe(s), {
    finished: true, status: 'completed', correct: 3, total: 3, succeeded: true,
  });
}

// --- 2. Regresi bug utama: semua salah → FAILED (bukan "Tantangan selesai") ---
{
  let s = start(tiga());
  s = wrongSkip(s, 3); // q1 kehabisan
  s = wrongSkip(s, 3); // q2 kehabisan
  s = wrongSkip(s, 3); // q3 kehabisan
  const d = describe(s);
  check('semua salah → failed, 0/3', d, {
    finished: true, status: 'failed', correct: 0, total: 3, succeeded: false,
  });
  check('semua salah → status bukan completed', d.status !== 'completed', true);
}

// --- 3. Jawaban salah pada soal TERAKHIR → failed (audio tetap berbunyi) ---
{
  let s = start(tiga());
  s = right(s);
  s = right(s);
  s = wrongSkip(s, 3); // soal terakhir dijawab salah 3x
  const d = describe(s);
  check('salah di soal terakhir → failed, 2/3', d, {
    finished: true, status: 'failed', correct: 2, total: 3, succeeded: false,
  });
}

// --- 4. Sebagian benar (q2 kehabisan) → failed walau q1 & q3 benar ---
{
  let s = start(tiga());
  s = right(s);
  s = wrongSkip(s, 3);
  s = right(s);
  const d = describe(s);
  check('parsial 2/3 → failed', d, {
    finished: true, status: 'failed', correct: 2, total: 3, succeeded: false,
  });
}

// --- 5. Retry DALAM soal yang sama lalu benar → tetap sah (completed) ---
{
  let s = start(tiga());
  s = wrongStay(s); // q1 salah #1
  s = wrongStay(s); // q1 salah #2, masih di soal yang sama
  s = right(s);     // q1 benar → lanjut
  s = right(s);
  s = right(s);
  const d = describe(s);
  check('retry dalam soal → completed 3/3', d, {
    finished: true, status: 'completed', correct: 3, total: 3, succeeded: true,
  });
}

// --- 6. Satu soal: benar → completed; kehabisan kesempatan → failed ---
{
  let s = start(satu());
  s = right(s);
  check('satu soal benar → completed 1/1', describe(s), {
    finished: true, status: 'completed', correct: 1, total: 1, succeeded: true,
  });
}
{
  let s = start(satu());
  s = wrongSkip(s, 3);
  check('satu soal kehabisan → failed 0/1', describe(s), {
    finished: true, status: 'failed', correct: 0, total: 1, succeeded: false,
  });
}

// --- 7. FORCE_FINISH (batas waktu / terlalu banyak salah) → failed ---
{
  let s = start(tiga());
  s = right(s);
  s = reducer(s, { type: 'FORCE_FINISH', status: 'failed' });
  const d = describe(s);
  check('batas waktu/mistake → failed', d, {
    finished: true, status: 'failed', correct: 1, total: 3, succeeded: false,
  });
}

// --- 8. Predikat murni getFinishedStatus / isSuccessfulChallenge ---
check('getFinishedStatus 3/3', getFinishedStatus(3, 3), 'completed');
check('getFinishedStatus 2/3', getFinishedStatus(2, 3), 'failed');
check('getFinishedStatus 0/3', getFinishedStatus(0, 3), 'failed');
check('getFinishedStatus 1/1', getFinishedStatus(1, 1), 'completed');
check('sukses: completed 3/3', isSuccessfulChallenge('completed', 3, 3), true);
check('bukan sukses: completed 2/3', isSuccessfulChallenge('completed', 2, 3), false);
check('bukan sukses: failed 3/3', isSuccessfulChallenge('failed', 3, 3), false);
check('bukan sukses: failed 0/3', isSuccessfulChallenge('failed', 0, 3), false);

// --- 9. Tak ada audio-stop pada jalur gagal (kebijakan Q6/Q7) ---
{
  const failCases = [
    { status: 'failed', correct: 0, total: 3 },
    { status: 'failed', correct: 2, total: 3 },
    { status: 'failed', correct: 2, total: 3 },
  ];
  let semuaAman = true;
  for (const c of failCases) {
    if (isSuccessfulChallenge(c.status, c.correct, c.total)) semuaAman = false;
  }
  check('tidak ada status gagal yang berstatus sukses', semuaAman, true);
}

console.log(`\nHasil: ${passed} lolos, ${failed} gagal.`);
process.exit(failed === 0 ? 0 : 1);