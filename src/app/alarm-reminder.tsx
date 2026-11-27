import { Image } from 'expo-image';
import { SymbolView } from 'expo-symbols';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { androidRipple } from '@/components/ui/android-ripple';
import { Spacing } from '@/constants/theme';
import { startAlarmAudio } from '@/lib/alarm-audio';
import { saveAlarmSession } from '@/lib/alarm-session';
import { acknowledgeNativePendingAlarm, getNativeAlarmEvent } from '@/lib/alarm-native';

const BRAND = {
  background: '#121212',
  text: '#F6F4EB',
  secondary: '#BDB8B0',
  accent: '#FF6B1F',
  outline: '#625F5A',
};

export default function AlarmReminderScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
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
  const sceneHeight = Math.min(420, Math.max(260, windowHeight * 0.4));

  useEffect(() => {
    if (!alarmId || !eventId || !generation) return;
    let alive = true;
    const activate = () => {
      if (alive) setOccurrenceValid(true);
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
    console.info('[MathWakeDiag]', {
      stage: 'reminder.actually.displayed',
      alarmId,
      eventId,
      generation,
      timestampMs: Date.now(),
    });
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

  const ready = !!alarmId && !!eventId && !!generation && occurrenceValid;

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(insets.bottom, Spacing.three) }]}
        showsVerticalScrollIndicator={false}>
        <View style={[styles.scene, { height: sceneHeight }]}>
          <Image
            source={require('../../assets/images/reminder-sunrise.png')}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            transition={0}
            accessible={false}
          />
          <View style={[styles.brandLockup, { paddingTop: insets.top + Spacing.two }]}>
            <Image
              source={require('../../assets/images/mathwake-mark.png')}
              style={styles.brandMark}
              contentFit="contain"
              accessible={false}
            />
            <ThemedText style={styles.brandName}>MathWake</ThemedText>
          </View>
          <View style={styles.statusBadge} accessibilityLiveRegion="polite">
            <View style={[styles.statusDot, { backgroundColor: ready ? BRAND.accent : BRAND.secondary }]} />
            <ThemedText style={styles.statusText}>
              {ready ? 'ALARM SEDANG BERBUNYI' : 'MEMERIKSA ALARM'}
            </ThemedText>
          </View>
        </View>

        <View style={styles.content}>
          <View style={styles.heading}>
            <ThemedText
              style={styles.time}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.72}
              accessibilityLabel={`Waktu alarm ${formatAlarmTime(triggerAtMs)}`}>
              {formatAlarmTime(triggerAtMs)}
            </ThemedText>
            <ThemedText style={styles.alarmTitle} accessibilityRole="header" numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.78}>
              {alarmTitle}
            </ThemedText>
            <ThemedText style={styles.tagline}>Waktunya bangun dan mulai hari dengan fokus.</ThemedText>
          </View>

          <View style={styles.challengeSection}>
            <ThemedText style={styles.eyebrow}>TANTANGAN MATEMATIKA</ThemedText>
            <View style={styles.challengeDetails}>
              <DetailItem label="SOAL" value={`${questionCount}`} />
              <View style={styles.detailDivider} />
              <DetailItem label="KESULITAN" value={DIFFICULTY_LABEL[difficulty] ?? difficulty} />
              {timeLimitSeconds > 0 ? (
                <>
                  <View style={styles.detailDivider} />
                  <DetailItem label="WAKTU" value={`${timeLimitSeconds} dtk`} />
                </>
              ) : null}
            </View>
          </View>

          <View style={styles.actions}>
            <Pressable
              onPress={openChallenge}
              disabled={!ready}
              accessibilityRole="button"
              accessibilityLabel="Mulai tantangan matematika"
              accessibilityState={{ disabled: !ready, busy: !ready }}
              android_ripple={androidRipple('#FFFFFF28')}
              style={({ pressed }) => [styles.primary, !ready && styles.disabled, pressed && styles.pressed]}>
              {ready ? (
                <>
                  <SymbolView name={{ ios: 'play.fill', android: 'play_arrow', web: 'play_arrow' }} size={22} tintColor={BRAND.background} />
                  <ThemedText style={styles.primaryText}>Mulai tantangan</ThemedText>
                </>
              ) : (
                <>
                  <ActivityIndicator color={BRAND.background} />
                  <ThemedText style={styles.primaryText}>Menyiapkan alarm</ThemedText>
                </>
              )}
            </Pressable>
            <Pressable
              onPress={() => {
                console.info('[MathWakeAlarm] reminder closed; alarm remains active', { alarmId, eventId });
                if (router.canGoBack()) router.back();
                else router.replace('/');
              }}
              accessibilityRole="button"
              accessibilityLabel="Tutup reminder"
              accessibilityHint="Alarm tetap berbunyi dan tantangan dapat dilanjutkan nanti"
              android_ripple={androidRipple('#FFFFFF18')}
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
              <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={18} tintColor={BRAND.secondary} />
              <ThemedText style={styles.secondaryText}>Tutup reminder</ThemedText>
            </Pressable>
          </View>

          <ThemedText style={styles.footerNote}>
            Alarm akan terus berbunyi sampai tantangan selesai.
          </ThemedText>
        </View>
      </ScrollView>
    </View>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailItem}>
      <ThemedText style={styles.detailLabel}>{label}</ThemedText>
      <ThemedText style={styles.detailValue}>{value}</ThemedText>
    </View>
  );
}

const DIFFICULTY_LABEL: Record<string, string> = { mudah: 'Mudah', sedang: 'Sedang', sulit: 'Sulit' };

function isValidUUID(value: string | undefined): value is string {
  return !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function clamp(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function formatAlarmTime(timestamp: number): string {
  const date = new Date(Number.isFinite(timestamp) ? timestamp : Date.now());
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BRAND.background },
  scrollContent: { flexGrow: 1, backgroundColor: BRAND.background },
  scene: { width: '100%', position: 'relative', justifyContent: 'space-between', overflow: 'hidden' },
  brandLockup: { paddingHorizontal: Spacing.four, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  brandMark: { width: 34, height: 34 },
  brandName: { color: BRAND.text, fontSize: 18, lineHeight: 24, fontWeight: '800', letterSpacing: -0.4 },
  statusBadge: {
    alignSelf: 'flex-start',
    marginHorizontal: Spacing.four,
    marginBottom: Spacing.three,
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: 'rgba(18,18,18,0.78)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: BRAND.text, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  content: { flex: 1, paddingHorizontal: Spacing.four, paddingTop: Spacing.three, gap: Spacing.three },
  heading: { gap: 2 },
  time: { color: BRAND.text, fontSize: 68, lineHeight: 76, fontWeight: '800', letterSpacing: -2, fontVariant: ['tabular-nums'] },
  alarmTitle: { color: BRAND.text, fontSize: 29, lineHeight: 36, fontWeight: '800', letterSpacing: -0.4 },
  tagline: { color: BRAND.secondary, fontSize: 15, lineHeight: 22, marginTop: 4 },
  challengeSection: { gap: Spacing.two, marginTop: Spacing.one },
  eyebrow: { color: BRAND.secondary, fontSize: 11, lineHeight: 16, fontWeight: '800', letterSpacing: 1.3 },
  challengeDetails: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: BRAND.outline,
    gap: Spacing.three,
  },
  detailItem: { gap: 3 },
  detailLabel: { color: BRAND.secondary, fontSize: 9, lineHeight: 13, fontWeight: '700', letterSpacing: 0.8 },
  detailValue: { color: BRAND.text, fontSize: 15, lineHeight: 20, fontWeight: '700' },
  detailDivider: { height: 28, width: StyleSheet.hairlineWidth, backgroundColor: BRAND.outline },
  actions: { gap: Spacing.two, marginTop: Spacing.one },
  primary: {
    minHeight: 60,
    borderRadius: 999,
    backgroundColor: BRAND.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
  },
  primaryText: { color: BRAND.background, fontSize: 17, lineHeight: 24, fontWeight: '800' },
  secondary: {
    minHeight: 54,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: BRAND.outline,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
  },
  secondaryText: { color: BRAND.secondary, fontSize: 15, lineHeight: 22, fontWeight: '700' },
  footerNote: { color: BRAND.secondary, fontSize: 12, lineHeight: 18, textAlign: 'center', paddingBottom: Spacing.one },
  disabled: { opacity: 0.6 },
  pressed: { opacity: 0.8, transform: [{ scale: 0.99 }] },
});
