import { useLocalSearchParams, useRouter } from 'expo-router';
import {
    forwardRef,
    useCallback,
    useEffect,
    useLayoutEffect,
    useReducer,
    useRef,
    useState,
} from 'react';
import {
    ActivityIndicator,
    AppState,
    AppStateStatus,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    StyleSheet,
    TextInput,
    View,
    useWindowDimensions,
} from 'react-native';
import { SymbolView } from 'expo-symbols';
import Animated, { FadeIn, FadeInDown, Keyframe, SlideInRight, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { androidRipple } from '@/components/ui/android-ripple';
import { Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/auth-context';
import { useTheme } from '@/hooks/use-theme';
import { greetingForOccurrence } from '@/lib/greeting';
import { setAlarmActive, snoozeMinutesOrDefault } from '@/lib/alarms';
import { isAlarmAudioPlaying, startAlarmAudio, stopAlarmAudio } from '@/lib/alarm-audio';
import {
  acknowledgeNativePendingAlarm,
  dismissNativeEventNotification,
  getNativeActiveAlarmEvent,
  getNativeAlarmEvent,
  snoozeNativeRing,
} from '@/lib/alarm-native';
import {
  initialState,
  isSuccessfulChallenge,
  reducer,
  WRONGS_BEFORE_ADVANCE,
} from '@/lib/challenge-state';
import {
    fetchQuestions,
    recordAlarmLog,
    recordAttempt,
    validateAnswer,
} from '@/lib/questions';
import { completeOnceOccurrenceIfCurrent } from '@/lib/scheduling';
import { clearAlarmSession, saveAlarmSession } from '@/lib/alarm-session';
import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// Route params
//
// Navigated to as:
//   router.push({
//     pathname: '/challenge',
//     params: {
//       alarmId:          '<uuid>',
//       difficulty:       'mudah' | 'sedang' | 'sulit',
//       questionCount:    '3',         // string — always stringify params
//       timeLimitSeconds: '60',        // 0 or missing = no limit
//       maxMistakes:      '2',         // 0 or missing = unlimited (session-wide)
//     },
//   });
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// State machine
//
// The challenge state machine (Phase/reducer/initialState and the
// WRONGS_BEFORE_ADVANCE rule) lives in src/lib/challenge-state.ts as a pure,
// testable module. Outcome contract: a challenge only reports 'completed'
// when EVERY question was answered correctly; any forced skip yields
// 'failed' and the alarm keeps ringing until the whole set is solved.
// ---------------------------------------------------------------------------

/** UI-only snapshot taken on tap; compared with reducer counters to render feedback. */
interface TapSnapshot {
  index: number;
  option: string | null;
  correctAt: number;
  mistakesAt: number;
}

export default function ChallengeScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const params = useLocalSearchParams<{
    alarmId?: string;
    alarmTitle?: string;
    difficulty?: string;
    questionCount?: string;
    timeLimitSeconds?: string;
    maxMistakes?: string;
    eventId?: string;
    generation?: string;
    triggerAtMs?: string;
  }>();

  // Parse + sanitize params. Never trust navigation values as authoritative
  // identifiers — alarmId is validated as a UUID before use.
  const alarmId = isValidUUID(params.alarmId) ? (params.alarmId ?? null) : null;
  const difficulty = ['mudah', 'sedang', 'sulit'].includes(params.difficulty ?? '')
    ? (params.difficulty ?? 'sedang')
    : 'sedang';
  const questionCount = clamp(parseInt(params.questionCount ?? '3', 10), 1, 10);
  const timeLimitSeconds = Math.max(0, parseInt(params.timeLimitSeconds ?? '0', 10));
  // maxMistakes is a SESSION-wide limit (total wrong across all questions).
  // Per-question retry logic is governed by WRONGS_BEFORE_ADVANCE, independently.
  const maxMistakes = Math.max(0, parseInt(params.maxMistakes ?? '0', 10));
  const alarmTitle = typeof params.alarmTitle === 'string' ? params.alarmTitle.trim().slice(0, 40) || 'Alarm' : 'Alarm';

  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [snoozeMinutes, setSnoozeMinutes] = useState(10);
  const [snoozeBusy, setSnoozeBusy] = useState(false);
  const [snoozeError, setSnoozeError] = useState<string | null>(null);
  const [alarmInactive, setAlarmInactive] = useState<'snoozed' | 'ended' | null>(null);
  const snoozeBusyRef = useRef(false);
  const occurrenceInactiveRef = useRef(false);
  const eventId = typeof params.eventId === 'string' ? params.eventId : '';
  const generation = typeof params.generation === 'string' ? params.generation : '';
  const triggerAtMs = Number(params.triggerAtMs);
  // Validation belongs to the full occurrence identity. Reusing the result
  // for the same eventId with a changed generation/alarm would leave a stale
  // route accepted until the next async ownership check completed.
  const occurrenceKey = JSON.stringify([alarmId, eventId, generation]);
  const [validatedOccurrenceKey, setValidatedOccurrenceKey] = useState(() =>
    eventId && !eventId.startsWith('mw1:') ? occurrenceKey : '',
  );
  const occurrenceValidated = validatedOccurrenceKey === occurrenceKey;
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const s = styles(insets, theme, windowHeight < 700);
  // UI-only: which option was tapped and the counters at tap time, for feedback.
  const [lastTap, setLastTap] = useState<TapSnapshot | null>(null);

  useEffect(() => {
    if (!alarmId || !eventId || !generation) {
      router.replace('/');
      return;
    }
    if (!user?.id) return;
    let alive = true;
    void (async () => {
      const [{ data: ownedAlarm, error: ownerError }, event, nativeOwner] = await Promise.all([
        supabase.from('alarms').select('id,snooze_minutes').eq('id', alarmId).eq('user_id', user.id).maybeSingle(),
        eventId.startsWith('mw1:') ? getNativeAlarmEvent(eventId) : Promise.resolve(null),
        eventId.startsWith('mw1:') ? getNativeActiveAlarmEvent() : Promise.resolve(null),
      ]);
      if (!alive) return;
      const nativeOccurrenceIsOwned = !eventId.startsWith('mw1:') || (
        event?.eventId === eventId && event.generation === generation && event.alarmId === alarmId && event.state === 'ringing' &&
        nativeOwner?.eventId === eventId && nativeOwner.generation === generation && nativeOwner.alarmId === alarmId
      );
      if (ownerError || !ownedAlarm || !nativeOccurrenceIsOwned) {
        router.replace('/');
        return;
      }
      setSnoozeMinutes(snoozeMinutesOrDefault((ownedAlarm as { snooze_minutes?: unknown }).snooze_minutes));
      setValidatedOccurrenceKey(occurrenceKey);
    })();
    return () => { alive = false; };
  }, [alarmId, eventId, generation, occurrenceKey, router, user?.id]);

  // Stable ref so effects don't need state in their dep arrays.
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  const inputRef = useRef<TextInput>(null);

  // Guard against double-submit: set to true between the submit call and the
  // next question dispatch, then back to false. Prevents rapid taps/enter
  // from triggering a second submit on the same question.
  const isSubmitting = useRef(false);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // ── Alarm audio: start on mount, keep playing until passed ───────────────
  //
  // The notification-tap handler starts audio before navigating here, but the
  // challenge can also be opened directly (deep link, retry via
  // router.replace, deep link). Starting here as well guarantees audio is
  // playing no matter which path opened the screen. startAlarmAudio is
  // idempotent per alarmId, so a double start is a no-op.
  //
  // Deliberately NO stop-on-unmount: closing this screen (back gesture,
  // "Tutup" after failure) must NOT silence the alarm. The ONLY stop call
  // in the app is on successful completion below.
  useEffect(() => {
    if (!alarmId || !eventId || !generation || !occurrenceValidated || occurrenceInactiveRef.current) return;
    void saveAlarmSession({
      alarmId,
      eventId,
      generation,
      triggerAtMs: Number.isFinite(triggerAtMs) ? triggerAtMs : Date.now(),
      difficulty,
      questionCount,
      timeLimitSeconds,
      maxMistakes,
      startedAt: Date.now(),
    });
    void startAlarmAudio(alarmId, eventId, generation);
  }, [alarmId, eventId, generation, triggerAtMs, occurrenceValidated, difficulty, questionCount, timeLimitSeconds, maxMistakes]);

  // If the OS kills audio while the challenge is backgrounded (or the player
  // errored and its stale map entry was cleared), restart it when the user
  // returns — the alarm must keep ringing until the challenge is passed.
  useEffect(() => {
    if (!alarmId || !eventId || !generation || !occurrenceValidated) return;
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (!isMounted.current) return;
      if (nextState === 'active' && !occurrenceInactiveRef.current && !isAlarmAudioPlaying(alarmId, eventId)) {
        void startAlarmAudio(alarmId, eventId, generation);
      }
    });
    return () => sub.remove();
  }, [alarmId, eventId, generation, occurrenceValidated]);

  // ── Load questions on mount ─────────────────────────────────────────────

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    fetchQuestions(supabase, { difficulty, count: questionCount, userId: user.id })
      .then((result) => {
        if (cancelled || !isMounted.current) return;
        if (result.shortfall === 'empty') {
          dispatch({ type: 'LOAD_EMPTY' });
        } else {
          dispatch({ type: 'LOAD_SUCCESS', questions: result.questions });
        }
      })
      .catch((e) => {
        if (cancelled || !isMounted.current) return;
        console.warn('[MathWake][Challenge] fetchQuestions error:', {
          message: e instanceof Error ? e.message : 'unknown',
        });
        dispatch({ type: 'LOAD_ERROR', message: 'Soal tidak dapat dimuat. Periksa koneksi lalu coba lagi.' });
      });

    return () => { cancelled = true; };
  }, [user, difficulty, questionCount]);

  // ── Per-question timer ──────────────────────────────────────────────────

  const questionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopQuestionTimer = useCallback(() => {
    if (questionTimerRef.current !== null) {
      clearInterval(questionTimerRef.current);
      questionTimerRef.current = null;
    }
  }, []);

  const settleInactiveOccurrence = useCallback((status: 'snoozed' | 'ended') => {
    if (occurrenceInactiveRef.current) return;
    occurrenceInactiveRef.current = true;
    if (isMounted.current) setAlarmInactive(status);
    stopQuestionTimer();
    if (alarmId) stopAlarmAudio(alarmId, eventId, generation);
    void clearAlarmSession(eventId);
    if (eventId.startsWith('mw1:')) {
      void dismissNativeEventNotification(eventId, generation);
      void acknowledgeNativePendingAlarm(eventId, generation);
    }
  }, [alarmId, eventId, generation, stopQuestionTimer]);

  const handleSnooze = useCallback(async () => {
    if (snoozeBusyRef.current || occurrenceInactiveRef.current || !occurrenceValidated) return;
    if (!alarmId || !eventId.startsWith('mw1:') || !generation) {
      setSnoozeError('Snooze native Android tidak tersedia untuk occurrence ini.');
      return;
    }
    snoozeBusyRef.current = true;
    setSnoozeBusy(true);
    setSnoozeError(null);
    try {
      const [event, owner] = await Promise.all([
        getNativeAlarmEvent(eventId),
        getNativeActiveAlarmEvent(),
      ]);
      if (
        !event || event.alarmId !== alarmId || event.eventId !== eventId ||
        event.generation !== generation || event.state !== 'ringing' ||
        owner?.alarmId !== alarmId || owner.eventId !== eventId || owner.generation !== generation
      ) {
        if (event?.state === 'snoozed') settleInactiveOccurrence('snoozed');
        else if (event && (event.state !== 'ringing' || owner?.eventId !== eventId)) settleInactiveOccurrence('ended');
        else if (isMounted.current) setSnoozeError('Alarm ini sudah tidak aktif. Buka alarm yang sedang berbunyi untuk menundanya.');
        return;
      }
      const result = await snoozeNativeRing(alarmId, eventId, generation, snoozeMinutes);
      if (!result?.success) {
        const [latest, latestOwner] = await Promise.all([
          getNativeAlarmEvent(eventId),
          getNativeActiveAlarmEvent(),
        ]);
        if (latest?.state === 'snoozed') settleInactiveOccurrence('snoozed');
        else if (latest && (latest.state !== 'ringing' || latestOwner?.eventId !== eventId)) settleInactiveOccurrence('ended');
        else if (isMounted.current) setSnoozeError(
          latest?.state === 'ringing' && latestOwner?.eventId === eventId
            ? 'Snooze gagal. Alarm masih berbunyi; silakan coba lagi.'
            : 'Status alarm tidak dapat dipastikan. Periksa alarm sebelum mencoba kembali.',
        );
        return;
      }
      settleInactiveOccurrence('snoozed');
    } finally {
      snoozeBusyRef.current = false;
      if (isMounted.current) setSnoozeBusy(false);
    }
  }, [alarmId, eventId, generation, occurrenceValidated, snoozeMinutes, settleInactiveOccurrence]);

  // A native notification action can snooze while the challenge Activity is
  // already mounted. Reconcile persisted occurrence ownership without JS
  // being involved in the notification action itself.
  useEffect(() => {
    if (!occurrenceValidated || !eventId.startsWith('mw1:') || !generation || !alarmId) return;
    let alive = true;
    const reconcile = async () => {
      if (occurrenceInactiveRef.current) return;
      const [event, owner] = await Promise.all([
        getNativeAlarmEvent(eventId),
        getNativeActiveAlarmEvent(),
      ]);
      if (!alive || !event) return;
      if (event.state === 'snoozed') {
        settleInactiveOccurrence('snoozed');
      } else if (event.state === 'completed' && stateRef.current.phase.kind === 'finished') {
        return;
      } else if (
        event.state !== 'ringing' || event.generation !== generation || event.alarmId !== alarmId ||
        (owner !== null && (owner.eventId !== eventId || owner.generation !== generation))
      ) {
        settleInactiveOccurrence('ended');
      }
    };
    void reconcile();
    const timer = setInterval(() => void reconcile(), 1200);
    return () => { alive = false; clearInterval(timer); };
  }, [occurrenceValidated, alarmId, eventId, generation, settleInactiveOccurrence]);

  const snoozeAction = eventId.startsWith('mw1:') ? (
    <View style={s.snoozeControl}>
      <Pressable
        onPress={() => void handleSnooze()}
        disabled={snoozeBusy || !occurrenceValidated || !!alarmInactive}
        style={({ pressed }) => [s.snoozeButton, pressed && s.pressed, (snoozeBusy || !!alarmInactive) && s.disabled]}
        accessibilityRole="button"
        accessibilityLabel={`Tunda alarm ${snoozeMinutes} menit`}
        accessibilityState={{ disabled: snoozeBusy || !occurrenceValidated || !!alarmInactive, busy: snoozeBusy }}
        android_ripple={androidRipple(theme.primarySoft)}>
        {snoozeBusy ? (
          <ActivityIndicator color={theme.textSecondary} />
        ) : (
          <View style={s.buttonRow}>
            <SymbolView name={{ ios: 'zzz', android: 'snooze', web: 'snooze' }} size={18} tintColor={theme.textSecondary} />
            <ThemedText style={s.snoozeButtonText}>Tunda {snoozeMinutes} menit</ThemedText>
          </View>
        )}
      </Pressable>
      {snoozeError ? <ThemedText type="small" style={s.snoozeError} accessibilityRole="alert">{snoozeError}</ThemedText> : null}
    </View>
  ) : null;

  const startQuestionTimer = useCallback(() => {
    stopQuestionTimer();
    const TICK = 200;
    questionTimerRef.current = setInterval(() => {
      if (!isMounted.current) return;
      dispatch({ type: 'TICK_QUESTION', deltaMs: TICK });
      dispatch({ type: 'TICK_SESSION', deltaMs: TICK });
    }, TICK);
  }, [stopQuestionTimer]);

  useEffect(() => {
    if (state.phase.kind === 'playing') {
      startQuestionTimer();
    } else {
      stopQuestionTimer();
    }
    return stopQuestionTimer;
  }, [state.phase.kind, state.currentIndex, startQuestionTimer, stopQuestionTimer]);

  // ── Enforce time limit (session-wide) ────────────────────────────────────

  useEffect(() => {
    if (timeLimitSeconds <= 0) return;
    if (state.phase.kind !== 'playing') return;
    if (state.sessionElapsedMs >= timeLimitSeconds * 1000) {
      dispatch({ type: 'FORCE_FINISH', status: 'failed' });
    }
  }, [state.sessionElapsedMs, state.phase.kind, timeLimitSeconds]);

  // ── Enforce maxMistakes (session-wide wrong count) ────────────────────────

  useEffect(() => {
    if (maxMistakes <= 0) return;
    if (state.phase.kind !== 'playing') return;
    if (state.mistakeCount >= maxMistakes) {
      dispatch({ type: 'FORCE_FINISH', status: 'failed' });
    }
  }, [state.mistakeCount, state.phase.kind, maxMistakes]);

  // ── Pause timer when app goes to background ──────────────────────────────

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (!isMounted.current) return;
      if (nextState === 'active') {
        if (stateRef.current.phase.kind === 'playing') startQuestionTimer();
      } else {
        stopQuestionTimer();
      }
    });
    return () => sub.remove();
  }, [startQuestionTimer, stopQuestionTimer]);

  // ── Record alarm_log and (for passed only) stop the alarm ───────────────
  //
  // Two separate refs prevent double-execution if the effect fires more than
  // once (e.g. React Strict Mode double-invoke or rapid re-renders):
  //   resultsRecorded — guards alarm_log insert (runs for both passed/failed)
  //   completionDone  — guards the one-time alarm cancellation (passed only)

  const resultsRecorded = useRef(false);
  const completionDone = useRef(false);

  useEffect(() => {
    if (!occurrenceValidated || state.phase.kind !== 'finished') return;
    if (resultsRecorded.current) return;
    if (!user) return;

    resultsRecorded.current = true;

    // Always record the session outcome in alarm_logs.
    if (alarmId) {
      recordAlarmLog(supabase, {
        userId: user.id,
        alarmId,
        status: state.phase.status,
      });
    }

    // Only a successful completion may stop the alarm.
    if (
      alarmId &&
      !completionDone.current &&
      state.phase.kind === 'finished' &&
      isSuccessfulChallenge(
        state.phase.status,
        state.phase.correctCount,
        state.questions.length,
      )
    ) {
      completionDone.current = true;

      // Stop the alarm audio immediately when the user passes the challenge.
      // This is the ONLY place that stops audio — failed challenges and retry
      // paths never call stopAlarmAudio. Because the reducer only reports
      // 'completed' when EVERY question was answered correctly, a wrong
      // answer, an exhausted retry, or a wrong final answer all land in
      // 'failed' and keep the alarm ringing (JS loop + native ringer).
      stopAlarmAudio(alarmId, eventId, generation);
      // Clear the persisted session only after audio/native teardown has been
      // requested, so a restart cannot observe a solved session while the
      // alarm is still being stopped.
      void clearAlarmSession(eventId);

      // Dismiss the sticky native alarm notification (if the native engine
      // posted one) and clear its pending marker so a later cold start does
      // not re-enter this challenge. Applies to once AND repeating alarms:
      // the next repeating occurrence was already re-armed at fire time.
      if (eventId.startsWith('mw1:')) {
        void dismissNativeEventNotification(eventId, generation);
        void acknowledgeNativePendingAlarm(eventId, generation);
      }

      // Fetch is_recurring to decide what to cancel.
      // Ownership is enforced by .eq('user_id', user.id).
      // Async IIFE (not .then().catch()): postgrest-js builders type as
      // PromiseLike, which has no .catch().
      void (async () => {
        try {
          const { data } = await supabase
            .from('alarms')
            .select('is_recurring')
            .eq('id', alarmId)
            .eq('user_id', user.id)
            .single();
          const isOnce =
            (data as { is_recurring?: unknown } | null)?.is_recurring === false;
          if (isOnce) {
            // Serialize one-shot cleanup with local schedule changes so an old
            // event cannot cancel/deactivate a newer occurrence of this alarm.
            await completeOnceOccurrenceIfCurrent(
              alarmId,
              eventId,
              triggerAtMs,
              () => setAlarmActive(supabase, user.id, alarmId, false),
            );
          }
          // Repeating alarm: the next occurrence was already re-armed at fire
          // time (native engine) or persists as a weekly/daily trigger (expo
          // engine) — don't cancel it. Nothing to do here; the user will
          // receive the next scheduled alarm as expected.
        } catch (e) {
          console.warn('[MathWake][Challenge] alarm completion cleanup failed:', {
            message: e instanceof Error ? e.message : 'unknown',
          });
        }
      })();
    }
  }, [state.phase, state.questions.length, user, alarmId, eventId, generation, triggerAtMs, occurrenceValidated]);

  // ── Core submit logic — shared by free-text and multiple-choice ──────────
  //
  // Retry rules (per question):
  //   wrong #1 → show feedback, clear input, stay on question
  //   wrong #2 → show feedback, clear input, show "last chance" hint
  //   wrong #3 → show feedback briefly, then advance to next question
  //   correct  → advance to next question
  //
  // Attempts are always recorded, including wrong ones.

  const submitAnswer = useCallback((rawAnswer: string) => {
    // Prevent double-submit during transition delay.
    if (isSubmitting.current) return;

    const { phase, questions, currentIndex, questionElapsedMs, perQuestionMistakes } =
      stateRef.current;
    if (phase.kind !== 'playing') return;
    if (rawAnswer.trim() === '') return;

    const question = questions[currentIndex];
    if (!question) return;

    isSubmitting.current = true;

    const isCorrect = validateAnswer(rawAnswer, question);
    const timeTaken = questionElapsedMs;

    // Always record this attempt (correct or wrong).
    if (user) {
      recordAttempt(supabase, {
        userId: user.id,
        alarmId,
        question,
        userAnswer: rawAnswer.trim(),
        isCorrect,
        timeTakenMs: timeTaken,
      });
    }

    if (isCorrect) {
      dispatch({ type: 'CORRECT_ANSWER', timeTakenMs: timeTaken });
      const delay = 300;
      setTimeout(() => {
        if (!isMounted.current) return;
        dispatch({ type: 'NEXT_QUESTION' });
        isSubmitting.current = false;
        requestAnimationFrame(() => inputRef.current?.focus());
      }, delay);
      return;
    }

    // Wrong answer.
    dispatch({ type: 'WRONG_ANSWER', timeTakenMs: timeTaken });

    // After this dispatch perQuestionMistakes will be +1 from what we read
    // (the ref hasn't updated yet — we use the value we captured).
    const wrongsAfterThis = perQuestionMistakes + 1;

    if (wrongsAfterThis >= WRONGS_BEFORE_ADVANCE) {
      // Third wrong — show feedback briefly then move on.
      setTimeout(() => {
        if (!isMounted.current) return;
        dispatch({ type: 'NEXT_QUESTION' });
        isSubmitting.current = false;
        requestAnimationFrame(() => inputRef.current?.focus());
      }, 900);
    } else {
      // First or second wrong — stay on the question; user can retry.
      // Input was already cleared by the WRONG_ANSWER reducer.
      isSubmitting.current = false;
    }
  }, [user, alarmId]);

  const handleSubmit = useCallback(() => {
    submitAnswer(stateRef.current.input);
  }, [submitAnswer]);

  // ── Navigate away from finished screen ───────────────────────────────────

  const handleDone = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }, [router]);

  // Retry: start a new challenge session with the same alarm config.
  // The current screen is replaced so back-nav doesn't return to the
  // failed result. resultsRecorded and completionDone are per-mount refs
  // so they reset naturally when the component remounts.
  const handleRetry = useCallback(() => {
    router.replace({
      pathname: '/challenge',
      params: {
        alarmId: alarmId ?? '',
        alarmTitle,
        eventId,
        generation,
        triggerAtMs: String(triggerAtMs),
        difficulty,
        questionCount: String(questionCount),
        timeLimitSeconds: String(timeLimitSeconds),
        maxMistakes: String(maxMistakes),
      },
    });
  }, [router, alarmId, alarmTitle, eventId, generation, triggerAtMs, difficulty, questionCount, timeLimitSeconds, maxMistakes]);

  // ── Render ───────────────────────────────────────────────────────────────

  if (!occurrenceValidated) {
    return (
      <ThemedView style={s.center}>
        <ActivityIndicator color={theme.primary} />
      </ThemedView>
    );
  }

  if (!user) {
    return (
      <ThemedView style={s.center}>
        <ThemedText type="small" themeColor="textSecondary">
          Sesi tidak valid. Silakan masuk kembali.
        </ThemedText>
      </ThemedView>
    );
  }

  if (alarmInactive) {
    return (
      <ThemedView style={s.center}>
        <ResultBadge tone={alarmInactive === 'snoozed' ? 'neutral' : 'success'} icon={alarmInactive === 'snoozed' ? 'snooze' : 'check'} theme={theme} />
        <ThemedText style={s.resultTitle}>{alarmInactive === 'snoozed' ? 'Alarm ditunda' : 'Alarm sudah tidak aktif'}</ThemedText>
        {alarmInactive === 'snoozed' ? <ThemedText type="small" themeColor="textSecondary" style={s.resultSub}>Alarm akan berbunyi kembali dalam {snoozeMinutes} menit.</ThemedText> : null}
        <Pressable style={({ pressed }) => [s.doneButton, pressed && s.pressed]} onPress={handleDone} accessibilityRole="button" accessibilityLabel="Kembali">
          <ThemedText style={s.doneButtonText}>Kembali</ThemedText>
        </Pressable>
      </ThemedView>
    );
  }

  if (state.phase.kind === 'loading') {
    return (
      <ThemedView style={s.center}>
        <View style={s.centerBody} accessibilityLiveRegion="polite">
          <ActivityIndicator size="large" color={theme.primary} />
          <ThemedText type="small" themeColor="textSecondary" style={s.loadingLabel}>
            Menyiapkan soal…
          </ThemedText>
          {snoozeAction}
        </View>
      </ThemedView>
    );
  }

  if (state.phase.kind === 'error') {
    return (
      <ThemedView style={s.center}>
        <ResultBadge tone="danger" icon="error" theme={theme} />
        <ThemedText style={s.resultTitle}>
          Soal tidak dapat dimuat
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={s.errorBody}>
          Periksa koneksi internet lalu coba lagi.
        </ThemedText>
        {snoozeAction}
        <Pressable
          style={({ pressed }) => [s.doneButton, pressed && s.pressed]}
          onPress={handleDone}
          accessibilityRole="button"
          accessibilityLabel="Kembali">
          <ThemedText style={s.doneButtonText}>Kembali</ThemedText>
        </Pressable>
      </ThemedView>
    );
  }

  if (state.phase.kind === 'empty') {
    return (
      <ThemedView style={s.center}>
        <ResultBadge tone="neutral" icon="empty" theme={theme} />
        <ThemedText style={s.resultTitle}>Belum ada soal</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={s.errorBody}>
          Soal untuk level {difficulty} belum tersedia. Hubungi administrator.
        </ThemedText>
        {snoozeAction}
        <Pressable
          style={({ pressed }) => [s.doneButton, pressed && s.pressed]}
          onPress={handleDone}
          accessibilityRole="button"
          accessibilityLabel="Kembali">
          <ThemedText style={s.doneButtonText}>Kembali</ThemedText>
        </Pressable>
      </ThemedView>
    );
  }

  if (state.phase.kind === 'finished') {
    const { status, correctCount } = state.phase;
    const total = state.questions.length;
    const accuracy = total > 0 ? Math.round((correctCount / total) * 100) : 0;
    const passed = status === 'completed';
    const successGreeting = greetingForOccurrence(triggerAtMs, new Date());
    const timedOut = !passed && timeLimitSeconds > 0 && state.sessionElapsedMs >= timeLimitSeconds * 1000;
    const tooManyMistakes = !passed && maxMistakes > 0 && state.mistakeCount >= maxMistakes;
    const elapsedSec = Math.round(state.sessionElapsedMs / 1000);

    return (
      <ThemedView style={s.center}>
        <View style={s.centerBody}>
          <ResultBadge tone={passed ? 'success' : 'danger'} icon={passed ? 'check' : 'error'} theme={theme} />
          <ThemedText style={s.resultTitle} accessibilityRole="header">
            {passed ? 'Tantangan selesai!' : 'Tantangan gagal'}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={s.resultSub}>
            {passed
              ? `Alarm dimatikan. ${successGreeting}`
              : 'Alarm masih berbunyi sampai semua soal terjawab benar.'}
          </ThemedText>

          <View style={s.statsRow} accessible accessibilityLabel={`${correctCount} dari ${total} benar, ${accuracy}% akurasi, ${elapsedSec} detik`}>
            <View style={s.stat}>
              <ThemedText style={s.statValue}>{correctCount}/{total}</ThemedText>
              <ThemedText style={s.statLabel} themeColor="textSecondary">benar</ThemedText>
            </View>
            <View style={s.statDivider} />
            <View style={s.stat}>
              <ThemedText style={s.statValue}>{accuracy}%</ThemedText>
              <ThemedText style={s.statLabel} themeColor="textSecondary">akurasi</ThemedText>
            </View>
            <View style={s.statDivider} />
            <View style={s.stat}>
              <ThemedText style={s.statValue}>{formatClock(elapsedSec)}</ThemedText>
              <ThemedText style={s.statLabel} themeColor="textSecondary">waktu</ThemedText>
            </View>
          </View>

          {timedOut ? (
            <View style={s.reasonPill}>
              <SymbolView name={{ ios: 'timer', android: 'timer', web: 'timer' }} size={16} tintColor={theme.danger} />
              <ThemedText style={s.reasonText}>Waktu habis</ThemedText>
            </View>
          ) : null}
          {tooManyMistakes ? (
            <View style={s.reasonPill}>
              <SymbolView name={{ ios: 'xmark.circle.fill', android: 'cancel', web: 'cancel' }} size={16} tintColor={theme.danger} />
              <ThemedText style={s.reasonText}>Terlalu banyak kesalahan ({state.mistakeCount})</ThemedText>
            </View>
          ) : null}

          {passed ? (
            // Passed: dismiss the challenge screen.
            <View style={s.resultActions}>
              <Pressable
                style={({ pressed }) => [
                  s.doneButton,
                  { backgroundColor: theme.success },
                  pressed && s.pressed,
                ]}
                onPress={handleDone}
                accessibilityRole="button"
                accessibilityLabel="Selesai">
                <ThemedText style={s.doneButtonText}>Selesai</ThemedText>
              </Pressable>
            </View>
          ) : (
            // Failed: offer retry (new session, same config) or dismiss.
            // Alarm is NOT stopped — it will keep ringing until the user passes.
            <View style={[s.resultActions, s.retryRow]}>
              <Pressable
                style={({ pressed }) => [s.retryButton, pressed && s.pressed]}
                onPress={handleRetry}
                accessibilityRole="button"
                accessibilityLabel="Coba lagi">
                <ThemedText style={s.retryButtonText}>Coba Lagi</ThemedText>
              </Pressable>
              {snoozeAction}
              <Pressable
                style={({ pressed }) => [s.dismissButton, pressed && s.pressed]}
                onPress={handleDone}
                accessibilityRole="button"
                accessibilityLabel="Tutup">
                <ThemedText style={s.dismissText}>Tutup</ThemedText>
              </Pressable>
            </View>
          )}
        </View>
      </ThemedView>
    );
  }

  // Playing state.
  const question = state.questions[state.currentIndex];
  const totalQ = state.questions.length;

  const remainingMs =
    timeLimitSeconds > 0
      ? Math.max(0, timeLimitSeconds * 1000 - state.sessionElapsedMs)
      : null;
  const remainingSec = remainingMs !== null ? Math.ceil(remainingMs / 1000) : null;
  const timeWarning = remainingSec !== null && remainingSec <= 10;

  // Show a "last chance" hint when the user is on their second wrong answer.
  const isLastChance = state.perQuestionMistakes === WRONGS_BEFORE_ADVANCE - 1;
  const forcedAdvance = state.perQuestionMistakes >= WRONGS_BEFORE_ADVANCE;
  // Disable submit while a transition is in progress (isSubmitting.current)
  // or while the wrong-feedback is showing after the third mistake.
  const submitDisabled =
    state.input.trim() === '' || (state.lastWasWrong && state.perQuestionMistakes >= WRONGS_BEFORE_ADVANCE);

  // Presentation-only feedback, derived by comparing reducer counters with the
  // snapshot taken at tap time. The reducer remains the single source of truth.
  const tapIsCurrent = lastTap !== null && lastTap.index === state.currentIndex;
  const showCorrect = tapIsCurrent && state.correctCount > lastTap.correctAt;
  const showWrong = state.lastWasWrong && !showCorrect;
  const wrongPick = showWrong && tapIsCurrent && state.perQuestionMistakes > lastTap.mistakesAt ? lastTap.option : null;
  const isMultipleChoice = !!question?.options && question.options.length > 0;
  const questionText = question?.question_text ?? '';
  const questionSize = fitQuestionSize(questionText, windowWidth);
  const triesLeft = Math.max(0, WRONGS_BEFORE_ADVANCE - state.perQuestionMistakes);

  const recordTap = (option: string | null) => {
    const current = stateRef.current;
    setLastTap({
      index: current.currentIndex,
      option,
      correctAt: current.correctCount,
      mistakesAt: current.perQuestionMistakes,
    });
  };
  const submitTyped = () => {
    recordTap(null);
    handleSubmit();
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ThemedView style={s.screen}>
        {/* ── Status: alarm, timer, progress ─────────────────────────────── */}
        <View style={s.statusZone}>
          <View style={s.statusRow}>
            <View style={s.statusTitleCol}>
              <ThemedText style={s.eyebrow} themeColor="textSecondary">
                {difficultyLabel(difficulty).toUpperCase()} · TANTANGAN
              </ThemedText>
              <ThemedText style={s.alarmTitle}>{alarmTitle}</ThemedText>
            </View>
            {remainingSec !== null ? (
              <View
                style={[s.timerPill, timeWarning && s.timerPillWarning]}
                accessibilityRole="timer"
                accessibilityLabel={`Sisa waktu ${remainingSec} detik`}>
                <SymbolView
                  name={{ ios: 'timer', android: 'timer', web: 'timer' }}
                  size={16}
                  tintColor={timeWarning ? theme.danger : theme.textSecondary}
                />
                <ThemedText style={[s.timerText, timeWarning && { color: theme.danger }]}>
                  {formatClock(remainingSec)}
                </ThemedText>
              </View>
            ) : null}
          </View>

          <View
            style={s.progressRow}
            accessibilityRole="progressbar"
            accessibilityLabel={`Soal ${state.currentIndex + 1} dari ${totalQ}`}
            accessibilityValue={{ min: 0, max: totalQ, now: state.currentIndex }}>
            <View style={s.segments} importantForAccessibility="no-hide-descendants">
              {state.questions.map((q, i) => (
                <View
                  key={q.id ?? i}
                  style={[
                    s.segment,
                    i < state.currentIndex && s.segmentDone,
                    i === state.currentIndex && s.segmentCurrent,
                  ]}
                />
              ))}
            </View>
            <ThemedText style={s.counter} themeColor="textSecondary" importantForAccessibility="no">
              {Math.min(state.currentIndex + 1, totalQ)}/{totalQ}
            </ThemedText>
          </View>

          {/* Session-wide mistake indicator (maxMistakes guard) */}
          {maxMistakes > 0 ? (
            <View
              style={s.mistakeRow}
              accessible
              accessibilityLabel={`Kesalahan ${state.mistakeCount} dari ${maxMistakes}`}>
              <ThemedText style={s.mistakeLabel} themeColor="textSecondary">Batas salah</ThemedText>
              <View style={s.mistakeDots}>
                {Array.from({ length: maxMistakes }).map((_, i) => (
                  <View
                    key={i}
                    style={[s.mistakeDot, i < state.mistakeCount ? s.mistakeDotFilled : s.mistakeDotEmpty]}
                  />
                ))}
              </View>
            </View>
          ) : null}
        </View>

        {/* ── Question: the visual focus ─────────────────────────────────── */}
        <View style={s.questionZone}>
          <Animated.View
            key={state.currentIndex}
            entering={reduceMotion ? undefined : SlideInRight.duration(240)}
            style={[
              s.questionCard,
              showCorrect && s.questionCardCorrect,
              showWrong && s.questionCardWrong,
            ]}>
            <ThemedText style={s.questionLabel} themeColor="textSecondary">
              Soal {state.currentIndex + 1}
            </ThemedText>
            <ThemedText
              style={[s.questionText, { fontSize: questionSize, lineHeight: Math.round(questionSize * 1.2) }]}
              accessibilityRole="header">
              {questionText}
            </ThemedText>
          </Animated.View>
        </View>

        {/* Reserved feedback slot: fixed height so answers never jump. */}
        <View style={s.feedbackSlot}>
          {showCorrect ? (
            <Animated.View
              entering={reduceMotion ? undefined : FadeIn.duration(140)}
              style={[s.feedback, s.feedbackCorrect]}
              accessibilityRole="alert"
              accessibilityLiveRegion="polite">
              <SymbolView
                name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }}
                size={18}
                tintColor={theme.success}
              />
              <ThemedText style={[s.feedbackText, { color: theme.success }]}>Benar!</ThemedText>
            </Animated.View>
          ) : showWrong ? (
            <Animated.View
              key={`wrong-${state.perQuestionMistakes}`}
              entering={reduceMotion ? undefined : FadeIn.duration(140)}
              style={[s.feedback, s.feedbackWrong]}
              accessibilityRole="alert"
              accessibilityLiveRegion="polite">
              <SymbolView
                name={{ ios: 'xmark.circle.fill', android: 'cancel', web: 'cancel' }}
                size={18}
                tintColor={theme.danger}
              />
              <ThemedText style={[s.feedbackText, { color: theme.danger }]}>
                {isLastChance
                  ? 'Salah. Satu kesempatan lagi!'
                  : forcedAdvance
                  ? 'Jawaban salah. Lanjut ke soal berikutnya…'
                  : 'Jawaban salah. Coba lagi.'}
              </ThemedText>
              {!forcedAdvance ? (
                <ThemedText style={s.feedbackMeta}>Sisa {triesLeft}×</ThemedText>
              ) : null}
            </Animated.View>
          ) : null}
        </View>

        {/* ── Answers: thumb zone ────────────────────────────────────────── */}
        <Animated.View
          key={`answers-${state.currentIndex}-${state.perQuestionMistakes}`}
          entering={!reduceMotion && state.perQuestionMistakes > 0 ? SHAKE : undefined}
          style={s.answerZone}>
          {isMultipleChoice ? (
            <MultipleChoice
              options={question!.options!}
              selected={state.input}
              disabled={state.perQuestionMistakes >= WRONGS_BEFORE_ADVANCE || showCorrect}
              lastWasWrong={state.lastWasWrong}
              correctAnswer={state.lastWasWrong ? question!.answer : null}
              correctPick={showCorrect ? lastTap!.option : null}
              wrongPick={wrongPick}
              theme={theme}
              onSelect={(opt) => {
                const q = stateRef.current.questions[stateRef.current.currentIndex];
                if (!q || stateRef.current.phase.kind !== 'playing') return;
                // Block taps while a transition is pending or on the third mistake.
                if (stateRef.current.perQuestionMistakes >= WRONGS_BEFORE_ADVANCE) return;
                recordTap(opt);
                submitAnswer(opt);
              }}
            />
          ) : (
            <View style={s.freeAnswer}>
              <FreeTextInput
                ref={inputRef}
                value={state.input}
                lastWasWrong={state.lastWasWrong}
                correct={showCorrect}
                onChangeText={(v) => dispatch({ type: 'SET_INPUT', value: v })}
                onSubmit={submitTyped}
                theme={theme}
              />
              <Pressable
                style={({ pressed }) => [
                  s.submitButton,
                  submitDisabled && s.submitButtonDisabled,
                  pressed && s.pressed,
                ]}
                onPress={submitTyped}
                disabled={submitDisabled}
                accessibilityRole="button"
                accessibilityLabel="Jawab"
                accessibilityState={{ disabled: submitDisabled }}
                android_ripple={androidRipple(theme.onPrimary)}>
                <ThemedText style={s.submitButtonText}>Jawab</ThemedText>
              </Pressable>
            </View>
          )}
        </Animated.View>

        {snoozeAction ? <View style={s.snoozeZone}>{snoozeAction}</View> : null}
      </ThemedView>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const FreeTextInput = forwardRef<
  TextInput,
  {
    value: string;
    lastWasWrong: boolean;
    correct: boolean;
    onChangeText: (v: string) => void;
    onSubmit: () => void;
    theme: ReturnType<typeof useTheme>;
  }
>(function FreeTextInput({ value, lastWasWrong, correct, onChangeText, onSubmit, theme }, ref) {
  return (
    <TextInput
      ref={ref}
      style={[
        freeInputStyle.input,
        {
          color: theme.text,
          borderColor: correct ? theme.success : lastWasWrong ? theme.danger : theme.border,
          backgroundColor: correct ? theme.successSoft : lastWasWrong ? theme.dangerSoft : theme.backgroundElement,
        },
      ]}
      value={value}
      onChangeText={onChangeText}
      onSubmitEditing={onSubmit}
      keyboardType="numeric"
      returnKeyType="done"
      placeholder="Ketik jawaban"
      placeholderTextColor={theme.textSecondary}
      autoFocus
      accessibilityLabel="Kolom jawaban"
    />
  );
});

const freeInputStyle = StyleSheet.create({
  input: {
    borderWidth: 2,
    borderRadius: Radius.control,
    paddingHorizontal: Spacing.three,
    minHeight: 64,
    paddingVertical: 12,
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
});

function MultipleChoice({
  options,
  selected,
  disabled,
  lastWasWrong,
  correctAnswer,
  correctPick,
  wrongPick,
  onSelect,
  theme,
}: {
  options: string[];
  selected: string;
  disabled: boolean;
  lastWasWrong: boolean;
  correctAnswer: string | null;
  correctPick: string | null;
  wrongPick: string | null;
  onSelect: (opt: string) => void;
  theme: ReturnType<typeof useTheme>;
}) {
  // Long options get a full-width row so text is never squeezed.
  const reduceMotion = useReducedMotion();
  const singleColumn = options.some((opt) => opt.length > 9);
  return (
    <View style={mcStyles.grid} accessibilityRole="radiogroup">
      {options.map((opt) => {
        const isSelected = opt === selected;
        const isCorrectReveal = (lastWasWrong && opt === correctAnswer) || opt === correctPick;
        const isWrongReveal = lastWasWrong && (opt === wrongPick || isSelected) && !isCorrectReveal;
        // Reveal states pair color with an icon so meaning never relies on color alone.
        let bg: string = theme.backgroundElement;
        let border: string = theme.border;
        let fg: string = theme.text;
        if (isCorrectReveal) [bg, border, fg] = [theme.successSoft, theme.success, theme.success];
        else if (isWrongReveal) [bg, border, fg] = [theme.dangerSoft, theme.danger, theme.danger];
        else if (isSelected && !lastWasWrong) [bg, border, fg] = [theme.primary, theme.primary, theme.onPrimary];
        const label = isCorrectReveal ? `${opt}, jawaban benar` : isWrongReveal ? `${opt}, jawaban salah` : opt;
        const dim = disabled && !isCorrectReveal && !isWrongReveal;
        return (
          <Pressable
            key={opt}
            style={({ pressed }) => [
              mcStyles.option,
              singleColumn && mcStyles.optionFull,
              { backgroundColor: bg, borderColor: border },
              pressed && !disabled && !reduceMotion && mcStyles.pressed,
              pressed && !disabled && reduceMotion && mcStyles.pressedReduced,
              dim && mcStyles.disabled,
            ]}
            onPress={() => !disabled && onSelect(opt)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={`Opsi ${label}`}
            accessibilityState={{ selected: isSelected, disabled }}
            android_ripple={androidRipple(theme.primarySoft)}>
            {isCorrectReveal || isWrongReveal ? (
              <SymbolView
                name={isCorrectReveal
                  ? { ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }
                  : { ios: 'xmark.circle.fill', android: 'cancel', web: 'cancel' }}
                size={20}
                tintColor={fg}
              />
            ) : null}
            <ThemedText style={[mcStyles.optText, { color: fg }]} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.8}>
              {opt}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

const mcStyles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two + 4,
  },
  option: {
    flexBasis: '45%',
    flexGrow: 1,
    minHeight: 68,
    borderWidth: 1.5,
    borderRadius: Radius.block,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    flexDirection: 'row',
    gap: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionFull: { flexBasis: '100%' },
  optText: {
    fontSize: 24,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
    flexShrink: 1,
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.97 }] },
  pressedReduced: { opacity: 0.85 },
  disabled: { opacity: 0.55 },
});

/** Small horizontal shake on a wrong answer; the system reduced-motion setting disables it. */
const SHAKE = new Keyframe({
  0: { transform: [{ translateX: 0 }] },
  20: { transform: [{ translateX: -8 }] },
  40: { transform: [{ translateX: 8 }] },
  60: { transform: [{ translateX: -5 }] },
  80: { transform: [{ translateX: 5 }] },
  100: { transform: [{ translateX: 0 }] },
}).duration(320);

function formatClock(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** Keeps short sums big and long word problems readable on narrow screens. */
function fitQuestionSize(text: string, width: number): number {
  const base = width < 360 ? 34 : width > 600 ? 48 : 40;
  if (text.length > 60) return Math.max(22, base - 16);
  if (text.length > 30) return Math.max(26, base - 10);
  if (text.length > 16) return base - 4;
  return base;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

type BadgeIcon = 'check' | 'error' | 'snooze' | 'empty';
const BADGE_SYMBOL = {
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  error: { ios: 'exclamationmark', android: 'priority_high', web: 'priority_high' },
  snooze: { ios: 'zzz', android: 'snooze', web: 'snooze' },
  empty: { ios: 'tray', android: 'inbox', web: 'inbox' },
} as const;

function ResultBadge({
  tone,
  icon,
  theme,
}: {
  tone: 'success' | 'danger' | 'neutral';
  icon: BadgeIcon;
  theme: ReturnType<typeof useTheme>;
}) {
  const reduceMotion = useReducedMotion();
  const [bg, fg] =
    tone === 'success'
      ? [theme.successSoft, theme.success]
      : tone === 'danger'
      ? [theme.dangerSoft, theme.danger]
      : [theme.primarySoft, theme.primaryStrong];
  return (
    <Animated.View
      entering={reduceMotion ? undefined : FadeInDown.duration(240)}
      style={[badgeStyles.ring, { backgroundColor: bg }]}
      importantForAccessibility="no-hide-descendants">
      <SymbolView name={BADGE_SYMBOL[icon]} size={40} tintColor={fg} />
    </Animated.View>
  );
}

const badgeStyles = StyleSheet.create({
  ring: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.two },
});

function styles(insets: ReturnType<typeof useSafeAreaInsets>, theme: ReturnType<typeof useTheme>, compact: boolean) {
  const primaryButton = {
    backgroundColor: theme.primary,
    borderRadius: Radius.control,
    minHeight: 56,
    paddingHorizontal: Spacing.five,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
  } as const;
  const gutter = compact ? Spacing.three : Spacing.four;
  return StyleSheet.create({
    screen: {
      flex: 1,
      paddingTop: insets.top + Spacing.two,
      paddingBottom: insets.bottom + Spacing.two,
      paddingHorizontal: gutter,
      width: '100%',
      maxWidth: 560,
      alignSelf: 'center',
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: Spacing.four,
      paddingTop: insets.top + Spacing.four,
      paddingBottom: insets.bottom + Spacing.four,
      gap: Spacing.three,
    },
    centerBody: { width: '100%', maxWidth: 420, alignItems: 'center', gap: Spacing.three },
    loadingLabel: { marginTop: Spacing.two },
    errorBody: { textAlign: 'center', lineHeight: 22, maxWidth: 360 },

    // Status zone
    statusZone: { gap: Spacing.three, paddingBottom: Spacing.two },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
    statusTitleCol: { flex: 1, gap: 2 },
    eyebrow: { fontSize: 12, fontWeight: '700', letterSpacing: 0.8 },
    alarmTitle: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
    timerPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.one,
      minHeight: 36,
      borderRadius: Radius.chip,
      paddingHorizontal: Spacing.three,
      backgroundColor: theme.backgroundElement,
      borderWidth: 1,
      borderColor: theme.border,
    },
    timerPillWarning: { backgroundColor: theme.dangerSoft, borderColor: theme.danger },
    timerText: { fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'], color: theme.text },
    progressRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
    segments: { flex: 1, flexDirection: 'row', gap: Spacing.one },
    segment: { flex: 1, height: 6, borderRadius: 3, backgroundColor: theme.backgroundSelected },
    segmentDone: { backgroundColor: theme.primary },
    segmentCurrent: { backgroundColor: theme.primarySoft, borderWidth: 1.5, borderColor: theme.primary },
    counter: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'], minWidth: 36, textAlign: 'right' },
    mistakeRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
    mistakeLabel: { fontSize: 13, fontWeight: '600' },
    mistakeDots: { flexDirection: 'row', gap: Spacing.one + 2 },
    mistakeDot: { width: 10, height: 10, borderRadius: 5 },
    mistakeDotFilled: { backgroundColor: theme.danger },
    mistakeDotEmpty: { backgroundColor: theme.backgroundSelected, borderWidth: 1, borderColor: theme.border },

    // Question zone
    questionZone: { flex: 1, justifyContent: 'center', minHeight: compact ? 140 : 180 },
    questionCard: {
      borderRadius: Radius.block + 4,
      paddingHorizontal: Spacing.four,
      paddingVertical: compact ? Spacing.four : Spacing.five,
      gap: Spacing.two,
      backgroundColor: theme.backgroundElement,
      borderWidth: 1.5,
      borderColor: theme.border,
      alignItems: 'center',
    },
    questionCardCorrect: { borderColor: theme.success, backgroundColor: theme.successSoft },
    questionCardWrong: { borderColor: theme.danger },
    questionLabel: { fontSize: 13, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
    questionText: { fontWeight: '800', textAlign: 'center', fontVariant: ['tabular-nums'], color: theme.text },

    // Feedback slot (fixed height keeps the answer grid from jumping)
    feedbackSlot: { minHeight: 52, justifyContent: 'center', paddingVertical: Spacing.one },
    feedback: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.two,
      minHeight: 44,
      paddingHorizontal: Spacing.three,
      borderRadius: Radius.control,
    },
    feedbackCorrect: { backgroundColor: theme.successSoft },
    feedbackWrong: { backgroundColor: theme.dangerSoft },
    feedbackText: { flex: 1, fontSize: 15, fontWeight: '700' },
    feedbackMeta: { fontSize: 13, fontWeight: '700', color: theme.danger, fontVariant: ['tabular-nums'] },

    // Answer zone
    answerZone: { paddingBottom: Spacing.two },
    freeAnswer: { gap: Spacing.three },
    submitButton: { ...primaryButton, alignSelf: undefined },
    submitButtonDisabled: { opacity: 0.45 },
    submitButtonText: { color: theme.onPrimary, fontWeight: '700', fontSize: 18 },

    // Snooze: secondary, separated from answers
    snoozeZone: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      paddingTop: Spacing.two,
    },
    snoozeControl: { alignItems: 'center', gap: Spacing.one, alignSelf: 'stretch' },
    snoozeButton: {
      minHeight: 48,
      alignSelf: 'stretch',
      borderRadius: Radius.control,
      paddingHorizontal: Spacing.four,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
    snoozeButtonText: { color: theme.textSecondary, fontSize: 16, fontWeight: '600' },
    snoozeError: { color: theme.danger, textAlign: 'center' },

    // Result / state screens
    resultTitle: { fontSize: 28, lineHeight: 34, fontWeight: '700', textAlign: 'center' },
    resultSub: { textAlign: 'center', lineHeight: 22 },
    statsRow: {
      flexDirection: 'row',
      alignSelf: 'stretch',
      borderRadius: Radius.block,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.backgroundElement,
      paddingVertical: Spacing.three,
    },
    stat: { flex: 1, alignItems: 'center', gap: 2 },
    statDivider: { width: StyleSheet.hairlineWidth, backgroundColor: theme.border },
    statValue: { fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'], color: theme.text },
    statLabel: { fontSize: 13, fontWeight: '600' },
    reasonPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.two,
      paddingHorizontal: Spacing.three,
      minHeight: 36,
      borderRadius: Radius.chip,
      backgroundColor: theme.dangerSoft,
    },
    reasonText: { color: theme.danger, fontSize: 14, fontWeight: '700' },
    resultActions: { alignSelf: 'stretch', gap: Spacing.two, marginTop: Spacing.two },
    doneButton: { ...primaryButton },
    doneButtonText: { color: theme.onPrimary, fontWeight: '700', fontSize: 17 },
    retryRow: { alignItems: 'stretch', alignSelf: 'stretch', gap: Spacing.two },
    retryButton: primaryButton,
    retryButtonText: { color: theme.onPrimary, fontWeight: '700', fontSize: 17 },
    dismissButton: { minHeight: 48, paddingHorizontal: Spacing.four, alignItems: 'center', justifyContent: 'center' },
    dismissText: { color: theme.textSecondary, fontSize: 16, fontWeight: '600' },
    pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
    disabled: { opacity: 0.5 },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidUUID(value: string | undefined): value is string {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function clamp(n: number, min: number, max: number): number {
  return Number.isNaN(n) ? min : Math.max(min, Math.min(max, n));
}

function difficultyLabel(d: string): string {
  if (d === 'mudah') return 'Mudah';
  if (d === 'sulit') return 'Sulit';
  return 'Sedang';
}
