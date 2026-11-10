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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Accent, Danger, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/auth-context';
import { useTheme } from '@/hooks/use-theme';
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

const SUCCESS_GREEN = '#22C55E' as const;

// ---------------------------------------------------------------------------
// State machine
//
// The challenge state machine (Phase/reducer/initialState and the
// WRONGS_BEFORE_ADVANCE rule) lives in src/lib/challenge-state.ts as a pure,
// testable module. Outcome contract: a challenge only reports 'completed'
// when EVERY question was answered correctly; any forced skip yields
// 'failed' and the alarm keeps ringing until the whole set is solved.
// ---------------------------------------------------------------------------

export default function ChallengeScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
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
  const s = styles(insets);

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

    fetchQuestions(supabase, { difficulty, count: questionCount })
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
        accessibilityLabel={`Tunda alarm ${snoozeMinutes} menit`}>
        {snoozeBusy ? <ActivityIndicator color="#ffffff" /> : <ThemedText style={s.snoozeButtonText}>Snooze {snoozeMinutes} menit</ThemedText>}
      </Pressable>
      {snoozeError ? <ThemedText type="small" style={s.snoozeError}>{snoozeError}</ThemedText> : null}
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
        <ActivityIndicator color={Accent} />
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
        <ThemedText style={s.resultIcon}>{alarmInactive === 'snoozed' ? '⏰' : '✓'}</ThemedText>
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
        <ActivityIndicator size="large" color={Accent} />
        <ThemedText type="small" themeColor="textSecondary" style={s.loadingLabel}>
          Memuat soal…
        </ThemedText>
        {snoozeAction}
      </ThemedView>
    );
  }

  if (state.phase.kind === 'error') {
    return (
      <ThemedView style={s.center}>
        <ThemedText type="smallBold" style={{ color: Danger }}>
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
        <ThemedText type="smallBold">Belum ada soal</ThemedText>
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

    return (
      <ThemedView style={s.center}>
        <ThemedText style={s.resultIcon}>{passed ? '✅' : '❌'}</ThemedText>
        <ThemedText style={s.resultTitle}>
          {passed ? 'Tantangan selesai!' : 'Tantangan gagal'}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={s.resultSub}>
          {correctCount} dari {total} benar · {accuracy}% akurasi
        </ThemedText>
        {!passed && timeLimitSeconds > 0 && state.sessionElapsedMs >= timeLimitSeconds * 1000 ? (
          <ThemedText type="small" style={[s.resultSub, { color: Danger }]}>
            Waktu habis
          </ThemedText>
        ) : null}
        {!passed && maxMistakes > 0 && state.mistakeCount >= maxMistakes ? (
          <ThemedText type="small" style={[s.resultSub, { color: Danger }]}>
            Terlalu banyak kesalahan ({state.mistakeCount})
          </ThemedText>
        ) : null}

        {passed ? (
          // Passed: dismiss the challenge screen.
          <Pressable
            style={({ pressed }) => [
              s.doneButton,
              { backgroundColor: SUCCESS_GREEN },
              pressed && s.pressed,
            ]}
            onPress={handleDone}
            accessibilityRole="button"
            accessibilityLabel="Selesai">
            <ThemedText style={s.doneButtonText}>Selesai</ThemedText>
          </Pressable>
        ) : (
          // Failed: offer retry (new session, same config) or dismiss.
          // Alarm is NOT stopped — it will keep ringing until the user passes.
          <View style={s.retryRow}>
            {snoozeAction}
            <Pressable
              style={({ pressed }) => [s.retryButton, pressed && s.pressed]}
              onPress={handleRetry}
              accessibilityRole="button"
              accessibilityLabel="Coba lagi">
              <ThemedText style={s.retryButtonText}>Coba Lagi</ThemedText>
            </Pressable>
            <Pressable
              style={({ pressed }) => [s.dismissButton, pressed && s.pressed]}
              onPress={handleDone}
              accessibilityRole="button"
              accessibilityLabel="Tutup">
              <ThemedText type="small" themeColor="textSecondary">Tutup</ThemedText>
            </Pressable>
          </View>
        )}
      </ThemedView>
    );
  }

  // Playing state.
  const question = state.questions[state.currentIndex];
  const totalQ = state.questions.length;
  const progressPct = totalQ > 0 ? state.currentIndex / totalQ : 0;

  const remainingMs =
    timeLimitSeconds > 0
      ? Math.max(0, timeLimitSeconds * 1000 - state.sessionElapsedMs)
      : null;
  const remainingSec = remainingMs !== null ? Math.ceil(remainingMs / 1000) : null;
  const timeWarning = remainingSec !== null && remainingSec <= 10;

  // Show a "last chance" hint when the user is on their second wrong answer.
  const isLastChance = state.perQuestionMistakes === WRONGS_BEFORE_ADVANCE - 1;
  // Disable submit while a transition is in progress (isSubmitting.current)
  // or while the wrong-feedback is showing after the third mistake.
  const submitDisabled =
    state.input.trim() === '' || (state.lastWasWrong && state.perQuestionMistakes >= WRONGS_BEFORE_ADVANCE);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ThemedView style={s.screen}>
        {/* Progress bar */}
        <View style={s.progressTrack}>
          <View style={[s.progressFill, { width: `${progressPct * 100}%` }]} />
        </View>

        {/* Header row: question number + optional timer */}
        <ThemedText type="smallBold" style={{ textAlign: 'center', marginBottom: Spacing.two }}>{alarmTitle}</ThemedText>
        <View style={s.header}>
          <ThemedText type="small" themeColor="textSecondary">
            Soal {state.currentIndex + 1} dari {totalQ}
          </ThemedText>
          {remainingSec !== null ? (
            <ThemedText
              type="smallBold"
              style={{ color: timeWarning ? Danger : undefined }}>
              {remainingSec}s
            </ThemedText>
          ) : null}
        </View>

        {/* Session-wide mistake indicator (maxMistakes guard) */}
        {maxMistakes > 0 ? (
          <View style={s.mistakeRow}>
            {Array.from({ length: maxMistakes }).map((_, i) => (
              <View
                key={i}
                style={[
                  s.mistakeDot,
                  i < state.mistakeCount ? s.mistakeDotFilled : s.mistakeDotEmpty,
                ]}
              />
            ))}
          </View>
        ) : null}

        {/* Question card */}
        <View style={[s.questionCard, { backgroundColor: theme.backgroundElement }]}>
          <ThemedText style={s.difficultyBadge} themeColor="textSecondary">
            {difficultyLabel(difficulty)}
          </ThemedText>
          <ThemedText style={s.questionText} accessibilityRole="text">
            {question?.question_text ?? ''}
          </ThemedText>
        </View>

        {/* Retry feedback messages */}
        {state.lastWasWrong ? (
          <ThemedText type="small" style={s.wrongFeedback}>
            {isLastChance
              ? 'Salah. Satu kesempatan lagi!'
              : state.perQuestionMistakes >= WRONGS_BEFORE_ADVANCE
              ? 'Jawaban salah. Lanjut ke soal berikutnya…'
              : 'Jawaban salah. Coba lagi.'}
          </ThemedText>
        ) : null}

        {/* Options (multiple choice) or free-text input */}
        {question?.options && question.options.length > 0 ? (
          <MultipleChoice
            options={question.options}
            selected={state.input}
            disabled={state.perQuestionMistakes >= WRONGS_BEFORE_ADVANCE}
            lastWasWrong={state.lastWasWrong}
            correctAnswer={state.lastWasWrong ? question.answer : null}
            onSelect={(opt) => {
              const q = stateRef.current.questions[stateRef.current.currentIndex];
              if (!q || stateRef.current.phase.kind !== 'playing') return;
              // Block taps while a transition is pending or on the third mistake.
              if (stateRef.current.perQuestionMistakes >= WRONGS_BEFORE_ADVANCE) return;
              submitAnswer(opt);
            }}
          />
        ) : (
          <FreeTextInput
            ref={inputRef}
            value={state.input}
            lastWasWrong={state.lastWasWrong}
            onChangeText={(v) => dispatch({ type: 'SET_INPUT', value: v })}
            onSubmit={handleSubmit}
            theme={theme}
          />
        )}

        {/* Submit button for free-text */}
        {(!question?.options || question.options.length === 0) && (
          <Pressable
            style={({ pressed }) => [
              s.submitButton,
              submitDisabled && s.submitButtonDisabled,
              pressed && s.pressed,
            ]}
            onPress={handleSubmit}
            disabled={submitDisabled}
            accessibilityRole="button"
            accessibilityLabel="Jawab">
            <ThemedText style={s.submitButtonText}>Jawab</ThemedText>
          </Pressable>
        )}
        {snoozeAction}
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
    onChangeText: (v: string) => void;
    onSubmit: () => void;
    theme: ReturnType<typeof useTheme>;
  }
>(function FreeTextInput({ value, lastWasWrong, onChangeText, onSubmit, theme }, ref) {
  return (
    <TextInput
      ref={ref}
      style={[
        freeInputStyle.input,
        {
          color: theme.text,
          borderColor: lastWasWrong ? Danger : theme.backgroundSelected,
          backgroundColor: theme.background,
        },
      ]}
      value={value}
      onChangeText={onChangeText}
      onSubmitEditing={onSubmit}
      keyboardType="numeric"
      returnKeyType="done"
      placeholder="Ketik jawaban…"
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
    paddingVertical: 14,
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    marginHorizontal: Spacing.four,
    fontVariant: ['tabular-nums'],
  },
});

function MultipleChoice({
  options,
  selected,
  disabled,
  lastWasWrong,
  correctAnswer,
  onSelect,
}: {
  options: string[];
  selected: string;
  disabled: boolean;
  lastWasWrong: boolean;
  correctAnswer: string | null;
  onSelect: (opt: string) => void;
}) {
  return (
    <View style={mcStyles.grid}>
      {options.map((opt) => {
        const isSelected = opt === selected;
        const isCorrectReveal = lastWasWrong && opt === correctAnswer;
        const isWrongReveal = lastWasWrong && isSelected && !isCorrectReveal;

        let bg = '#E0E1E6';
        if (isCorrectReveal) bg = SUCCESS_GREEN;
        else if (isWrongReveal) bg = Danger;
        else if (isSelected && !lastWasWrong) bg = Accent;

        return (
          <Pressable
            key={opt}
            style={({ pressed }) => [
              mcStyles.option,
              { backgroundColor: bg },
              pressed && !disabled && mcStyles.pressed,
              disabled && mcStyles.disabled,
            ]}
            onPress={() => !disabled && onSelect(opt)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={`Opsi ${opt}`}
            accessibilityState={{ selected: isSelected }}>
            <ThemedText
              style={[
                mcStyles.optText,
                (isSelected || isCorrectReveal || isWrongReveal) && { color: '#ffffff' },
              ]}>
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
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
    justifyContent: 'center',
  },
  option: {
    borderRadius: Radius.control,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
    minWidth: 120,
    alignItems: 'center',
  },
  optText: {
    fontSize: 20,
    fontWeight: '700',
  },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.6 },
});

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function styles(insets: ReturnType<typeof useSafeAreaInsets>) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      paddingTop: insets.top + Spacing.two,
      paddingBottom: insets.bottom + Spacing.four,
      gap: Spacing.three,
    },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: Spacing.four,
      gap: Spacing.three,
    },
    loadingLabel: {
      marginTop: Spacing.two,
    },
    errorBody: {
      textAlign: 'center',
      lineHeight: 22,
    },
    progressTrack: {
      height: 4,
      backgroundColor: '#E0E1E6',
    },
    progressFill: {
      height: 4,
      backgroundColor: Accent,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: Spacing.four,
    },
    mistakeRow: {
      flexDirection: 'row',
      gap: Spacing.two,
      paddingHorizontal: Spacing.four,
    },
    mistakeDot: {
      width: 12,
      height: 12,
      borderRadius: 6,
    },
    mistakeDotFilled: { backgroundColor: Danger },
    mistakeDotEmpty: { backgroundColor: '#E0E1E6' },
    questionCard: {
      marginHorizontal: Spacing.four,
      borderRadius: Radius.block,
      padding: Spacing.four,
      gap: Spacing.two,
      minHeight: 140,
      justifyContent: 'center',
    },
    difficultyBadge: {
      fontSize: 12,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    questionText: {
      fontSize: 32,
      lineHeight: 40,
      fontWeight: '700',
      textAlign: 'center',
    },
    wrongFeedback: {
      color: Danger,
      textAlign: 'center',
      paddingHorizontal: Spacing.four,
    },
    submitButton: {
      backgroundColor: Accent,
      borderRadius: Radius.control,
      paddingVertical: Spacing.three,
      alignItems: 'center',
      marginHorizontal: Spacing.four,
    },
    submitButtonDisabled: {
      opacity: 0.4,
    },
    submitButtonText: {
      color: '#ffffff',
      fontWeight: '700',
      fontSize: 18,
    },
    snoozeControl: {
      alignItems: 'center',
      gap: Spacing.one,
      marginHorizontal: Spacing.four,
    },
    snoozeButton: {
      minHeight: 48,
      alignSelf: 'stretch',
      backgroundColor: '#9A6D5B',
      borderRadius: Radius.control,
      paddingHorizontal: Spacing.four,
      alignItems: 'center',
      justifyContent: 'center',
    },
    snoozeButtonText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
    snoozeError: { color: Danger, textAlign: 'center' },
    resultIcon: {
      fontSize: 64,
      lineHeight: 72,
    },
    resultTitle: {
      fontSize: 28,
      fontWeight: '700',
      textAlign: 'center',
    },
    resultSub: {
      textAlign: 'center',
      lineHeight: 22,
    },
    doneButton: {
      backgroundColor: Accent,
      borderRadius: Radius.control,
      paddingVertical: Spacing.three,
      paddingHorizontal: Spacing.five,
      alignItems: 'center',
      marginTop: Spacing.two,
    },
    doneButtonText: {
      color: '#ffffff',
      fontWeight: '700',
      fontSize: 16,
    },
    retryRow: {
      alignItems: 'center',
      gap: Spacing.two,
      marginTop: Spacing.two,
    },
    retryButton: {
      backgroundColor: Accent,
      borderRadius: Radius.control,
      paddingVertical: Spacing.three,
      paddingHorizontal: Spacing.five,
      alignItems: 'center',
    },
    retryButtonText: {
      color: '#ffffff',
      fontWeight: '700',
      fontSize: 16,
    },
    dismissButton: {
      paddingVertical: Spacing.two,
      paddingHorizontal: Spacing.four,
      alignItems: 'center',
    },
    pressed: { opacity: 0.8 },
    disabled: { opacity: 0.6 },
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
