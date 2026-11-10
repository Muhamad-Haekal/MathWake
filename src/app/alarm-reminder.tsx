import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Accent, Radius, Spacing } from '@/constants/theme';
import { startAlarmAudio } from '@/lib/alarm-audio';
import { saveAlarmSession } from '@/lib/alarm-session';
import { acknowledgeNativePendingAlarm, getNativeAlarmEvent } from '@/lib/alarm-native';

export default function AlarmReminderScreen() {
  const router = useRouter();
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
  const alarmId = isValidUUID(params.alarmId) ? params.alarmId : null;
  const eventId = typeof params.eventId === 'string' ? params.eventId : null;
  const generation = typeof params.generation === 'string' ? params.generation : null;
  const triggerAtMs = Number(params.triggerAtMs);
  const [occurrenceValid, setOccurrenceValid] = useState(false);
  const difficulty = ['mudah', 'sedang', 'sulit'].includes(params.difficulty ?? '')
    ? params.difficulty!
    : 'sedang';
  const questionCount = clamp(params.questionCount, 1, 10, 3);
  const timeLimitSeconds = clamp(params.timeLimitSeconds, 0, Number.MAX_SAFE_INTEGER, 0);
  const maxMistakes = clamp(params.maxMistakes, 0, Number.MAX_SAFE_INTEGER, 0);
  const alarmTitle = typeof params.alarmTitle === 'string' ? params.alarmTitle.trim().slice(0, 40) || 'Alarm' : 'Alarm';

  useEffect(() => {
    if (!alarmId || !eventId || !generation) return;
    let alive = true;
    const activate = () => {
      if (!alive) return;
      setOccurrenceValid(true);
    };
    if (eventId.startsWith('mw1:')) {
      void getNativeAlarmEvent(eventId).then((event) => {
        if (!event || event.alarmId !== alarmId || event.generation !== generation || event.state !== 'ringing') return;
        activate();
      });
    } else activate();
    return () => { alive = false; };
  }, [alarmId, eventId, generation]);

  useEffect(() => {
    if (!alarmId || !eventId || !generation || !occurrenceValid) return;
    console.info('[MathWakeAlarm] reminder displayed', { alarmId });
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
    // The native ringer stays active until this player is actually playing.
    void startAlarmAudio(alarmId, eventId, generation);
    if (eventId.startsWith('mw1:')) void acknowledgeNativePendingAlarm(eventId, generation);
  }, [alarmId, eventId, generation, triggerAtMs, occurrenceValid, difficulty, questionCount, timeLimitSeconds, maxMistakes]);

  function openChallenge() {
    if (!alarmId || !eventId || !generation || !occurrenceValid) return;
    console.info('[MathWakeAlarm] reminder continued to challenge', { alarmId });
    router.replace({
      pathname: '/challenge',
      params: {
        alarmId,
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
  }

  return (
    <ThemedView style={styles.screen}>
      <View style={styles.card}>
        <ThemedText style={styles.emoji}>☀️</ThemedText>
        <ThemedText style={styles.title}>{alarmTitle}</ThemedText>
        <ThemedText themeColor="textSecondary" style={styles.body}>
          Alarm tetap berbunyi sampai kamu menyelesaikan tantangan matematika.
        </ThemedText>
        <Pressable
          onPress={openChallenge}
          disabled={!alarmId || !eventId || !generation || !occurrenceValid}
          accessibilityRole="button"
          accessibilityLabel="Buka Tantangan"
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
          <ThemedText style={styles.primaryText}>Buka Tantangan</ThemedText>
        </Pressable>
        <Pressable
          onPress={() => {
            console.info('[MathWakeAlarm] reminder closed; alarm remains active', { alarmId, eventId });
            if (router.canGoBack()) {
              router.back();
            } else {
              router.replace('/');
            }
          }}
          accessibilityRole="button"
          accessibilityLabel="Tutup reminder"
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
          <ThemedText themeColor="textSecondary">Tutup reminder</ThemedText>
        </Pressable>
      </View>
    </ThemedView>
  );
}

function isValidUUID(value: string | undefined): value is string {
  return !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function clamp(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: Spacing.four },
  card: { borderRadius: Radius.block, padding: Spacing.five, alignItems: 'center', gap: Spacing.three },
  emoji: { fontSize: 56 },
  title: { fontSize: 32, fontWeight: '800', textAlign: 'center' },
  body: { fontSize: 16, lineHeight: 24, textAlign: 'center' },
  primary: { width: '100%', borderRadius: Radius.control, backgroundColor: Accent, paddingVertical: Spacing.three, alignItems: 'center' },
  primaryText: { color: '#ffffff', fontSize: 17, fontWeight: '800' },
  secondary: { paddingVertical: Spacing.two },
  pressed: { opacity: 0.75 },
});
