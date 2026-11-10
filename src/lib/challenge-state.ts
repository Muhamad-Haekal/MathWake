import type { ChallengeStatus, QuestionRow } from './questions';

// ---------------------------------------------------------------------------
// Math Challenge state machine (pure, no platform imports).
//
// Extracted from src/app/challenge.tsx so the success/failure/retry rules can
// be unit-tested in Node (scripts/test-challenge-logic.mjs) without mounting
// the screen.
//
// Success contract (Phase 1, Core Alarm Reliability):
//   A challenge only "completes" when EVERY question was answered correctly.
//   Getting stuck on a question (WRONGS_BEFORE_ADVANCE wrong answers forces a
//   skip) makes the run FAIL, including when that happens on the LAST
//   question or with a partially-correct score. A failed run never stops the
//   alarm — the user retries until the whole set is solved. This is what
//   prevents "0 dari 3 benar · Tantangan selesai!" from ever being reported
//   as a success and keeps the alarm ringing.
// ---------------------------------------------------------------------------

/** How many wrong answers on a single question before it is forced to advance. */
export const WRONGS_BEFORE_ADVANCE = 3;

export type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'playing' }
  | { kind: 'finished'; status: ChallengeStatus; correctCount: number };

export interface ChallengeState {
  phase: Phase;
  questions: QuestionRow[];
  /** 0-based index into questions[]. */
  currentIndex: number;
  /** User's current text input for the active question. */
  input: string;
  /**
   * Whether the most recent submit on this question was wrong.
   * Drives the red-border feedback on the input / options.
   * Reset to false when the user starts typing again (SET_INPUT).
   */
  lastWasWrong: boolean;
  /**
   * Wrong-answer count for the CURRENT question only.
   * Reset to 0 on NEXT_QUESTION.
   * Determines when to force-advance (>= WRONGS_BEFORE_ADVANCE).
   * Distinct from mistakeCount, which is the session-wide total used
   * by the maxMistakes guard.
   */
  perQuestionMistakes: number;
  /** Session-wide correct-answer count. */
  correctCount: number;
  /** Session-wide wrong-answer count (used only by the maxMistakes guard). */
  mistakeCount: number;
  /** Elapsed ms for the current question (counts up). */
  questionElapsedMs: number;
  /** Elapsed ms for the entire session. */
  sessionElapsedMs: number;
}

export type ChallengeAction =
  | { type: 'LOAD_SUCCESS'; questions: QuestionRow[] }
  | { type: 'LOAD_ERROR'; message: string }
  | { type: 'LOAD_EMPTY' }
  | { type: 'SET_INPUT'; value: string }
  | { type: 'WRONG_ANSWER'; timeTakenMs: number }
  | { type: 'CORRECT_ANSWER'; timeTakenMs: number }
  | { type: 'NEXT_QUESTION' }
  | { type: 'TICK_QUESTION'; deltaMs: number }
  | { type: 'TICK_SESSION'; deltaMs: number }
  | { type: 'FORCE_FINISH'; status: ChallengeStatus };

export function initialState(): ChallengeState {
  return {
    phase: { kind: 'loading' },
    questions: [],
    currentIndex: 0,
    input: '',
    lastWasWrong: false,
    perQuestionMistakes: 0,
    correctCount: 0,
    mistakeCount: 0,
    questionElapsedMs: 0,
    sessionElapsedMs: 0,
  };
}

/**
 * Terminal status for a challenge whose LAST advance was made by answering
 * the final question correctly: success requires a perfect score. Any run
 * that reached the end with unanswered/forced-skip questions is a failure —
 * a partially-correct score never silences the alarm.
 */
export function getFinishedStatus(
  correctCount: number,
  totalQuestions: number,
): ChallengeStatus {
  return correctCount >= totalQuestions ? 'completed' : 'failed';
}

/**
 * The single gate for turning the alarm OFF. The reducer only produces
 * 'completed' when every question was answered correctly, but this predicate
 * also guards the side-effect that stops audio / dismisses the notification /
 * deactivates a one-time alarm, so a wrong answer or a forced skip can never
 * be treated as success regardless of how the finished phase was reached.
 */
export function isSuccessfulChallenge(
  status: ChallengeStatus,
  correctCount: number,
  totalQuestions: number,
): boolean {
  return status === 'completed' && correctCount >= totalQuestions;
}

export function reducer(state: ChallengeState, action: ChallengeAction): ChallengeState {
  switch (action.type) {
    case 'LOAD_SUCCESS':
      return { ...state, phase: { kind: 'playing' }, questions: action.questions };

    case 'LOAD_ERROR':
      return { ...state, phase: { kind: 'error', message: action.message } };

    case 'LOAD_EMPTY':
      return { ...state, phase: { kind: 'empty' } };

    case 'SET_INPUT':
      if (state.phase.kind !== 'playing') return state;
      // Clear wrong-feedback whenever the user edits the input so the
      // field returns to neutral and the submit button re-enables.
      return { ...state, input: action.value, lastWasWrong: false };

    case 'WRONG_ANSWER': {
      if (state.phase.kind !== 'playing') return state;
      return {
        ...state,
        lastWasWrong: true,
        perQuestionMistakes: state.perQuestionMistakes + 1,
        mistakeCount: state.mistakeCount + 1,
        // Clear the text field so the user can type a fresh answer.
        input: '',
      };
    }

    case 'CORRECT_ANSWER': {
      if (state.phase.kind !== 'playing') return state;
      return {
        ...state,
        lastWasWrong: false,
        correctCount: state.correctCount + 1,
        input: '',
      };
    }

    case 'NEXT_QUESTION': {
      if (state.phase.kind !== 'playing') return state;
      const next = state.currentIndex + 1;
      if (next >= state.questions.length) {
        // Last question advanced past the end. The status is derived from
        // the actual score, never blindly 'completed': a forced skip on the
        // last question (3 wrong answers) yields correctCount < total, which
        // must be reported as FAILED so the alarm keeps ringing.
        const status = getFinishedStatus(state.correctCount, state.questions.length);
        return {
          ...state,
          phase: { kind: 'finished', status, correctCount: state.correctCount },
          currentIndex: next,
          questionElapsedMs: 0,
          lastWasWrong: false,
          perQuestionMistakes: 0,
        };
      }
      return {
        ...state,
        currentIndex: next,
        input: '',
        lastWasWrong: false,
        perQuestionMistakes: 0,
        questionElapsedMs: 0,
      };
    }

    case 'TICK_QUESTION':
      if (state.phase.kind !== 'playing') return state;
      return { ...state, questionElapsedMs: state.questionElapsedMs + action.deltaMs };

    case 'TICK_SESSION':
      if (state.phase.kind !== 'playing') return state;
      return { ...state, sessionElapsedMs: state.sessionElapsedMs + action.deltaMs };

    case 'FORCE_FINISH':
      if (state.phase.kind !== 'playing') return state;
      return {
        ...state,
        phase: { kind: 'finished', status: action.status, correctCount: state.correctCount },
        questionElapsedMs: 0,
        lastWasWrong: false,
        perQuestionMistakes: 0,
      };

    default:
      return state;
  }
}