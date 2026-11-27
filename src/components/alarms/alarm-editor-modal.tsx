import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Gesture, GestureDetector, GestureHandlerRootView, type PanGesture } from 'react-native-gesture-handler';
import Reanimated, {
  FadeIn,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
    DIFFICULTY_OPTIONS,
    WEEKDAY_PRESETS,
    createNewAlarmForm,
    dayNumbersToTokens,
    nowTime,
    scheduleKindOf,
    shiftTime,
    splitTimeParts,
    validateAlarmForm,
    SNOOZE_INTERVALS,
    snoozeMinutesOrDefault,
    type AlarmForm,
    type ScheduleKind,
} from '@/lib/alarms';
import type { AlarmRow } from '@/lib/home-data';
import {
  applyCustomRingtoneResult,
  createAlarmEditorDraft,
  type AlarmEditorDraft,
} from '@/lib/alarm-editor-draft-logic';
import {
    describeAlarmDay,
    formatTimeID,
    formatCountdown,
    nextOccurrenceForAlarm,
    nextOnceOccurrence,
    parseRepeatDays,
} from '@/lib/home-data';
import {
  DEFAULT_ALARM_RINGTONE,
  getAlarmRingtone,
  setAlarmRingtone,
  type AlarmRingtone,
} from '@/lib/alarm-ringtones';
import { previewRingtone, stopRingtonePreview } from '@/lib/ringtone-preview';
import { getChallengeQuestionPreview } from '@/lib/question-preview';
import { MATHWAKE_ALARM_SOUND } from '@/lib/alarm-sound';
import {
  getNativeDefaultAlarmRingtoneUri,
  pickNativeAlarmRingtone,
} from '@/lib/alarm-native';

// Monday-first display order; internal values stay 0 = Sunday .. 6 = Saturday.
const DAY_BUTTONS: { value: number; label: string }[] = [
  { value: 1, label: 'Sen' },
  { value: 2, label: 'Sel' },
  { value: 3, label: 'Rab' },
  { value: 4, label: 'Kam' },
  { value: 5, label: 'Jum' },
  { value: 6, label: 'Sab' },
  { value: 0, label: 'Min' },
];

const DAY_INITIALS = ['S', 'S', 'R', 'K', 'J', 'S', 'M'];

const QUICK_ADDS: { label: string; minutes: number }[] = [
  { label: '+10 mnt', minutes: 10 },
  { label: '+30 mnt', minutes: 30 },
  { label: '+1 jam', minutes: 60 },
];

type RepeatChoice = 'once' | 'weekdays' | 'daily' | 'custom';
const REPEAT_OPTIONS: { value: RepeatChoice; label: string }[] = [
  { value: 'once', label: 'Sekali' },
  { value: 'weekdays', label: 'Hari kerja' },
  { value: 'daily', label: 'Setiap hari' },
  { value: 'custom', label: 'Kustom' },
];

type Panel = 'challenge' | 'snooze' | 'sound';
type SymbolName = SymbolViewProps['name'];
const SYMBOLS = {
  up: { ios: 'chevron.up', android: 'keyboard_arrow_up', web: 'keyboard_arrow_up' },
  down: { ios: 'chevron.down', android: 'keyboard_arrow_down', web: 'keyboard_arrow_down' },
  plus: { ios: 'plus', android: 'add', web: 'add' },
  minus: { ios: 'minus', android: 'remove', web: 'remove' },
  bell: { ios: 'bell.fill', android: 'notifications', web: 'notifications' },
  challenge: { ios: 'function', android: 'calculate', web: 'calculate' },
  snooze: { ios: 'zzz', android: 'snooze', web: 'snooze' },
  sound: { ios: 'music.note', android: 'music_note', web: 'music_note' },
  active: { ios: 'power', android: 'power_settings_new', web: 'power_settings_new' },
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  folder: { ios: 'folder', android: 'folder_open', web: 'folder_open' },
  trash: { ios: 'trash', android: 'delete', web: 'delete' },
  warning: { ios: 'exclamationmark.circle.fill', android: 'error', web: 'error' },
} as const satisfies Record<string, SymbolName>;

const MAX_SHEET_WIDTH = 640;
const SCRIM = 'rgba(20, 12, 9, 0.45)';

function diag(stage: string, details?: Record<string, unknown>) {
  console.info('[MathWakeDiag]', { stage, timestampMs: Date.now(), ...details });
}

interface AlarmEditorModalProps {
  visible: boolean;
  /** Null when creating a new alarm. */
  alarm: AlarmRow | null;
  saving: boolean;
  draft: AlarmEditorDraft | null;
  onClose: () => void;
  onDraftChange: (draft: AlarmEditorDraft) => void;
  onSave: (form: AlarmForm, ringtone: AlarmRingtone) => Promise<AlarmRow | null>;
  onDelete: (alarm: AlarmRow) => void;
}

function formFromAlarm(alarm: AlarmRow | null): AlarmForm {
  if (!alarm) return createNewAlarmForm();
  const parts = splitTimeParts(alarm.time);
  const repeat = parseRepeatDays(alarm.days);
  const isRecurring = alarm.is_recurring !== false;
  return {
    title: typeof alarm.title === 'string' ? alarm.title : '',
    time: parts
      ? `${String(parts.h).padStart(2, '0')}:${String(parts.m).padStart(2, '0')}`
      : '06:00',
    days: isRecurring && repeat ? [...repeat] : [],
    is_recurring: isRecurring,
    is_active: alarm.is_active,
    difficulty:
      alarm.difficulty && (DIFFICULTY_OPTIONS as readonly string[]).includes(alarm.difficulty)
        ? alarm.difficulty
        : 'sedang',
    question_count:
      typeof alarm.question_count === 'number' && alarm.question_count >= 1
        ? Math.min(alarm.question_count, 10)
        : 3,
    snooze_minutes: snoozeMinutesOrDefault(alarm.snooze_minutes),
  };
}

// ---------------------------------------------------------------------------
// Inner content component — holds all form state and ringtone loading.
//
// AlarmEditorModal renders this with a key that changes whenever the modal
// opens for a different alarm (or as "new"). React remounts this component
// on key change, re-running the lazy useState initialisers and re-firing the
// ringtone-loading effect. No useEffect is needed to reset state between opens.
// ---------------------------------------------------------------------------

interface AlarmEditorContentProps {
  alarm: AlarmRow | null;
  draft: AlarmEditorDraft | null;
  saving: boolean;
  insets: ReturnType<typeof useSafeAreaInsets>;
  theme: ReturnType<typeof useTheme>;
  dragGesture: PanGesture;
  onClose: () => void;
  onDraftChange: (draft: AlarmEditorDraft) => void;
  onSave: (form: AlarmForm, ringtone: AlarmRingtone) => Promise<AlarmRow | null>;
  onDelete: (alarm: AlarmRow) => void;
}

function AlarmEditorContent({
  alarm,
  draft,
  saving,
  insets,
  theme,
  dragGesture,
  onClose,
  onDraftChange,
  onSave,
  onDelete,
}: AlarmEditorContentProps) {
  const styles = useEditorStyles();
  // Lazy initialisers: evaluated once on mount (key controls when that is).
  const matchesDraft = !!draft && draft.alarmId === (alarm?.id ?? null);
  const [form, setForm] = useState<AlarmForm>(() => draft?.alarmId === (alarm?.id ?? null) ? draft.form : formFromAlarm(alarm));
  const questionPreview = getChallengeQuestionPreview(form.difficulty);
  const [kind, setKind] = useState<ScheduleKind>(() => {
    if (draft?.alarmId === (alarm?.id ?? null)) return draft.kind;
    const f = formFromAlarm(alarm);
    return scheduleKindOf(f.is_recurring, f.days);
  });
  const [localError, setLocalError] = useState<string | null>(null);
  const ringtoneAlarmId = alarm?.id ?? 'draft';
  const [ringtone, setRingtone] = useState<AlarmRingtone>(() =>
    draft?.alarmId === (alarm?.id ?? null) ? draft.ringtone : DEFAULT_ALARM_RINGTONE,
  );
  const [ringtoneReady, setRingtoneReady] = useState(matchesDraft || !alarm);
    const ringtoneSelectionVersion = useRef(0);
  const [openPanel, setOpenPanel] = useState<Panel | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [clockNow, setClockNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setClockNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    diag('editor.content.mount');
    return () => { diag('editor.content.unmount'); };
  }, []);

  useEffect(() => {
    if (matchesDraft) return;
    let active = true;
      const selectionVersion = ringtoneSelectionVersion.current;
    void getAlarmRingtone(ringtoneAlarmId).then((value) => {
      if (active) {
          if (ringtoneSelectionVersion.current === selectionVersion) setRingtone(value);
        setRingtoneReady(true);
      }
    });
    return () => { active = false; stopRingtonePreview(); };
  }, [matchesDraft, ringtoneAlarmId]);

  useEffect(() => {
    if (!ringtoneReady) return;
    onDraftChange(createAlarmEditorDraft({
      alarmId: alarm?.id ?? null,
      form,
      kind,
      ringtone,
    }));
  }, [alarm?.id, form, kind, onDraftChange, ringtone, ringtoneReady]);

  async function chooseRingtone(value: AlarmRingtone) {
    diag('chooseRingtone.start', { kind: value.kind, hasUri: Boolean(value.uri) });
      const selectionVersion = ++ringtoneSelectionVersion.current;
    stopRingtonePreview();
    setRingtone(value);
      setRingtoneReady(true);
    if (value.kind === 'custom' && value.uri) void previewRingtone(value.uri);
    if (value.kind === 'mathwake') void previewRingtone(MATHWAKE_ALARM_SOUND);
    if (value.kind === 'system') {
      const uri = await getNativeDefaultAlarmRingtoneUri();
      if (uri) void previewRingtone(uri);
    }
      // An explicit ringtone choice for an existing alarm is an independent
      // user setting. Persist it immediately so a screen/app refresh cannot
      // silently restore MathWake before the rest of the form is saved.
      if (alarm?.id) {
        try {
          await setAlarmRingtone(alarm.id, value);
          if (selectionVersion === ringtoneSelectionVersion.current) setLocalError(null);
        } catch {
          if (selectionVersion === ringtoneSelectionVersion.current) {
            setLocalError('Suara alarm tidak dapat disimpan. Pilih audio lagi lalu coba kembali.');
          }
        }
      }
  }

  function setKindOption(next: ScheduleKind) {
    setKind(next);
    setForm((f) => {
      if (next === 'once') return { ...f, is_recurring: false, days: [] };
      if (next === 'daily') return { ...f, is_recurring: true, days: [0, 1, 2, 3, 4, 5, 6] };
      return {
        ...f,
        is_recurring: true,
        days: f.days.length > 0 && f.days.length < 7 ? f.days : [],
      };
    });
  }

  function applyPreset(days: number[]) {
    setKind('custom');
    setForm((f) => ({ ...f, is_recurring: true, days }));
  }

  function toggleDay(value: number) {
    setKind('custom');
    setForm((f) => ({
      ...f,
      is_recurring: true,
      days: f.days.includes(value) ? f.days.filter((d) => d !== value) : [...f.days, value],
    }));
  }

  async function handleSave() {
      if (saving || !ringtoneReady) return;
    const invalid = validateAlarmForm(form);
    if (invalid) {
      setLocalError(invalid);
      return;
    }
    setLocalError(null);
    const saved = await onSave(form, ringtone);
    if (saved) {
      stopRingtonePreview();
      onClose();
    }
  }

  // Next-occurrence preview, split by kind: one-time alarms use the
  // single-occurrence logic (null when past), recurring alarms use the
  // repeating search. Never rolls a one-time alarm to tomorrow.
  const previewNow = clockNow;
  const preview =
    kind === 'once'
      ? nextOnceOccurrence({ time: `${form.time}:00` }, previewNow)
      : nextOccurrenceForAlarm(
          { time: `${form.time}:00`, days: dayNumbersToTokens(form.days) } as AlarmRow,
          previewNow,
        );

  const [hourValue, minuteValue] = form.time.split(':').map(Number);
  const stepHour = (delta: number) => setForm((f) => ({ ...f, time: shiftTime(f.time, delta * 60) }));
  // Minute stepper wraps within the hour (59 -> 00) instead of carrying into it.
  const stepMinute = (delta: number) => setForm((f) => {
    const [h, m] = f.time.split(':').map(Number);
    const next = (((m + delta) % 60) + 60) % 60;
    return { ...f, time: `${String(h).padStart(2, '0')}:${String(next).padStart(2, '0')}` };
  });

  const isWeekdays = form.days.length === 5 && [1, 2, 3, 4, 5].every((day) => form.days.includes(day));
  const repeatChoice: RepeatChoice =
    kind === 'once'
      ? 'once'
      : customOpen
      ? 'custom'
      : kind === 'daily' || form.days.length === 7
      ? 'daily'
      : isWeekdays
      ? 'weekdays'
      : 'custom';

  function chooseRepeat(next: RepeatChoice) {
    setCustomOpen(next === 'custom');
    if (next === 'once') setKindOption('once');
    else if (next === 'daily') setKindOption('daily');
    else if (next === 'weekdays') applyPreset([1, 2, 3, 4, 5]);
    else setKindOption('custom');
  }

  const togglePanel = (panel: Panel) => setOpenPanel((current) => (current === panel ? null : panel));
  const weekendDays = WEEKDAY_PRESETS.find((item) => item.key === 'weekend')?.days ?? [0, 6];
  const timeLabel = formatTimeID(form.time);

  const pickCustomRingtone = async () => {
               diag('picker.handler.start');
              stopRingtonePreview();
              try {
                const nativeResult = await pickNativeAlarmRingtone(
                  ringtone.kind === 'custom' ? ringtone.uri : null,
                );
                 diag('picker.native.result', {
                   received: nativeResult !== null,
                   cancelled: nativeResult?.cancelled ?? null,
                   hasUri: Boolean(nativeResult?.uri),
                   reason: nativeResult?.reason ?? null,
                 });
                if (nativeResult && nativeResult.reason !== 'picker-unavailable') {
                  if (nativeResult.cancelled || !nativeResult.uri) return;
                  await chooseRingtone(applyCustomRingtoneResult(ringtone, {
                    canceled: false,
                    name: nativeResult.name,
                    uri: nativeResult.uri,
                  }));
                  return;
                }

                const result = await DocumentPicker.getDocumentAsync({
                  type: 'audio/*',
                  copyToCacheDirectory: true,
                  multiple: false,
                });
                 diag('picker.document.result', {
                   cancelled: result.canceled,
                   hasAsset: Boolean(result.assets?.[0]),
                 });
                if (result.canceled || !result.assets?.[0]) return;
                const asset = result.assets[0];
                await chooseRingtone(applyCustomRingtoneResult(ringtone, {
                  canceled: false,
                  name: asset.name,
                  uri: asset.uri,
                }));
              } finally {
                stopRingtonePreview();
                 diag('picker.handler.end');
              }
  };

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <GestureDetector gesture={dragGesture}>
      <View style={styles.header}>
        <View style={styles.handle} />
        <View style={styles.headerRow}>
          <Pressable
            disabled={saving}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Batal"
            hitSlop={8}
            style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
            <ThemedText style={styles.headerCancel}>Batal</ThemedText>
          </Pressable>
          <ThemedText style={styles.headerTitle} accessibilityRole="header" numberOfLines={1}>
            {alarm ? 'Edit alarm' : 'Alarm baru'}
          </ThemedText>
          <Pressable
            disabled={saving || !ringtoneReady}
            onPress={handleSave}
            accessibilityRole="button"
            accessibilityLabel="Simpan alarm"
            accessibilityState={{ disabled: saving || !ringtoneReady, busy: saving }}
            hitSlop={8}
            style={({ pressed }) => [styles.saveButton, pressed && styles.pressed, (saving || !ringtoneReady) && styles.disabled]}>
            {saving ? <ActivityIndicator size="small" color={theme.onPrimary} /> : <ThemedText style={styles.saveText}>Simpan</ThemedText>}
          </Pressable>
        </View>
      </View>
      </GestureDetector>

      {localError ? (
        <Reanimated.View
          entering={FadeIn.duration(160)}
          style={styles.errorBanner}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite">
          <SymbolView name={SYMBOLS.warning} size={18} tintColor={theme.danger} />
          <ThemedText style={styles.errorText}>{localError}</ThemedText>
        </Reanimated.View>
      ) : null}

      <ScrollView
        style={styles.flex}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + Spacing.five }]}>
        {/* Waktu: 24 jam, sama dengan format daftar alarm. */}
        <View style={styles.timeBlock}>
          <View style={styles.timeRow}>
            <TimeStepper label="Jam" unit="jam" value={hourValue} disabled={saving} onStep={stepHour} />
            <ThemedText style={styles.timeColon} importantForAccessibility="no">:</ThemedText>
            <TimeStepper label="Menit" unit="menit" value={minuteValue} disabled={saving} onStep={stepMinute} />
          </View>
          {preview ? (
            <View style={styles.previewPill} accessibilityLiveRegion="polite">
              <SymbolView name={SYMBOLS.bell} size={16} tintColor={theme.primaryStrong} />
              <ThemedText style={styles.previewText}>
                {describeAlarmDay(preview, previewNow)}, {timeLabel} · {formatCountdown(preview, previewNow)}
              </ThemedText>
            </View>
          ) : kind === 'once' ? (
            <ThemedText style={styles.pastText} accessibilityLiveRegion="polite">
              Waktu ini sudah lewat hari ini. Pilih waktu yang akan datang.
            </ThemedText>
          ) : null}
          <View style={styles.quickRow}>
            {QUICK_ADDS.map(({ label, minutes }) => (
              <Pressable
                key={label}
                disabled={saving}
                onPress={() => setForm((f) => ({ ...f, time: shiftTime(nowTime(), minutes) }))}
                accessibilityRole="button"
                accessibilityLabel={`Atur ${label} dari sekarang`}
                style={({ pressed }) => [styles.quickChip, pressed && styles.pressed]}>
                <ThemedText style={styles.quickText}>{label}</ThemedText>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <ThemedText style={styles.sectionLabel}>Nama alarm</ThemedText>
          <TextInput
            value={form.title}
            onChangeText={(title) => setForm((f) => ({ ...f, title: title.slice(0, 40) }))}
            maxLength={40}
            editable={!saving}
            placeholder="Opsional, mis. Bangun kerja"
            placeholderTextColor={theme.textSecondary}
            accessibilityLabel="Nama alarm, opsional"
            style={styles.input}
            returnKeyType="done"
          />
        </View>

        <View style={styles.section}>
          <ThemedText style={styles.sectionLabel}>Ulangi</ThemedText>
          <SegmentedControl options={REPEAT_OPTIONS} value={repeatChoice} disabled={saving} onChange={chooseRepeat} />
          {repeatChoice === 'custom' ? (
            <Reanimated.View entering={FadeIn.duration(180)} style={styles.daysBlock}>
              <View style={styles.daysRow}>
                {DAY_BUTTONS.map(({ value, label }, index) => {
                  const selected = form.days.includes(value);
                  return (
                    <Pressable
                      key={value}
                      disabled={saving}
                      onPress={() => toggleDay(value)}
                      accessibilityRole="checkbox"
                      accessibilityLabel={label}
                      accessibilityState={{ checked: selected, disabled: saving }}
                      style={({ pressed }) => [styles.dayButton, selected && styles.daySelected, pressed && styles.pressed]}>
                      <ThemedText style={[styles.dayText, selected && styles.dayTextSelected]}>{DAY_INITIALS[index]}</ThemedText>
                    </Pressable>
                  );
                })}
              </View>
              <Pressable
                disabled={saving}
                onPress={() => applyPreset(weekendDays)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.inlineLink, pressed && styles.pressed]}>
                <ThemedText style={styles.inlineLinkText}>Pilih akhir pekan</ThemedText>
              </Pressable>
            </Reanimated.View>
          ) : null}
        </View>

        <View style={styles.group}>
          <ListRow
            icon={SYMBOLS.challenge}
            label="Tantangan"
            value={`${capitalize(form.difficulty)} · ${form.question_count} soal`}
            expanded={openPanel === 'challenge'}
            disabled={saving}
            onPress={() => togglePanel('challenge')}
          />
          {openPanel === 'challenge' ? (
            <Reanimated.View entering={FadeIn.duration(180)} style={styles.panel}>
              <ThemedText style={styles.panelLabel}>Level</ThemedText>
              <View style={styles.chipRow}>
                {DIFFICULTY_OPTIONS.map((option) => {
                  const selected = form.difficulty === option;
                  return (
                    <Pressable
                      key={option}
                      disabled={saving}
                      onPress={() => setForm((f) => ({ ...f, difficulty: option }))}
                      accessibilityRole="radio"
                      accessibilityState={{ selected, disabled: saving }}
                      accessibilityLabel={`Level ${option}`}
                      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.pressed]}>
                      <ThemedText style={[styles.chipText, selected && styles.chipTextSelected]}>{capitalize(option)}</ThemedText>
                    </Pressable>
                  );
                })}
              </View>
              <View style={styles.previewCard}>
                <View style={styles.previewHeader}>
                  <ThemedText style={styles.previewEyebrow}>CONTOH SOAL</ThemedText>
                  <ThemedText style={styles.previewLevel}>{capitalize(form.difficulty)}</ThemedText>
                </View>
                <ThemedText style={styles.previewDescription}>{questionPreview.description}</ThemedText>
                <View style={styles.previewList}>
                  {questionPreview.examples.map((example, index) => (
                    <View key={example} style={styles.previewRow}>
                      <ThemedText style={styles.previewNumber}>{String(index + 1).padStart(2, '0')}</ThemedText>
                      <ThemedText style={styles.previewExpression}>{example}</ThemedText>
                    </View>
                  ))}
                </View>
              </View>
              <TimeStepperRow
                label="Jumlah soal"
                value={String(form.question_count)}
                saving={saving}
                minusDisabled={form.question_count <= 1}
                plusDisabled={form.question_count >= 10}
                onMinus={() => setForm((f) => ({ ...f, question_count: f.question_count - 1 }))}
                onPlus={() => setForm((f) => ({ ...f, question_count: f.question_count + 1 }))}
              />
            </Reanimated.View>
          ) : null}

          <View style={styles.divider} />
          <ListRow
            icon={SYMBOLS.snooze}
            label="Snooze"
            value={<ThemedText style={styles.rowValue}>{form.snooze_minutes} min</ThemedText>}
            expanded={openPanel === 'snooze'}
            disabled={saving}
            onPress={() => togglePanel('snooze')}
          />
          {openPanel === 'snooze' ? (
            <Reanimated.View entering={FadeIn.duration(180)} style={styles.panel}>
              <View style={styles.chipRow} accessibilityRole="radiogroup">
                {SNOOZE_INTERVALS.map((minutes) => {
                  const selected = form.snooze_minutes === minutes;
                  return (
                    <Pressable
                      key={minutes}
                      disabled={saving}
                      onPress={() => setForm((current) => ({ ...current, snooze_minutes: minutes }))}
                      accessibilityRole="radio"
                      accessibilityLabel={`${minutes} menit`}
                      accessibilityState={{ selected, disabled: saving }}
                      style={({ pressed }) => [styles.chip, styles.chipFlex, selected && styles.chipSelected, pressed && styles.pressed]}>
                      <ThemedText style={[styles.chipText, selected && styles.chipTextSelected]}>{minutes} mnt</ThemedText>
                    </Pressable>
                  );
                })}
              </View>
            </Reanimated.View>
          ) : null}

          <View style={styles.divider} />
          <ListRow
            icon={SYMBOLS.sound}
            label="Suara"
            value={ringtone.name}
            expanded={openPanel === 'sound'}
            disabled={saving}
            onPress={() => togglePanel('sound')}
          />
          {openPanel === 'sound' ? (
            <Reanimated.View entering={FadeIn.duration(180)} style={styles.panelFlush}>
                {[DEFAULT_ALARM_RINGTONE].map((option) => {
                const selected = ringtone.kind === option.kind;
                return (
                  <Pressable
                    key={option.kind}
                    disabled={saving}
                    onPress={() => void chooseRingtone(option)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected, disabled: saving }}
                    style={({ pressed }) => [styles.optionRow, pressed && styles.rowPressed]}>
                    <ThemedText style={[styles.optionText, selected && styles.optionTextSelected]}>{option.name}</ThemedText>
                    {selected ? <SymbolView name={SYMBOLS.check} size={18} tintColor={theme.primaryStrong} /> : null}
                  </Pressable>
                );
              })}
              <Pressable
                disabled={saving}
                onPress={() => void pickCustomRingtone()}
                accessibilityRole="button"
                accessibilityLabel="Pilih audio kustom"
                accessibilityState={{ selected: ringtone.kind === 'custom', disabled: saving }}
                style={({ pressed }) => [styles.optionRow, pressed && styles.rowPressed]}>
                <ThemedText numberOfLines={1} style={[styles.optionText, ringtone.kind === 'custom' && styles.optionTextSelected]}>
                  {ringtone.kind === 'custom' ? ringtone.name : 'Pilih audio kustom…'}
                </ThemedText>
                <SymbolView
                  name={ringtone.kind === 'custom' ? SYMBOLS.check : SYMBOLS.folder}
                  size={18}
                  tintColor={ringtone.kind === 'custom' ? theme.primaryStrong : theme.textSecondary}
                />
              </Pressable>
              <ThemedText style={styles.hint}>
                Default MathWake digunakan jika akses audio kustom dicabut atau tidak valid.
              </ThemedText>
            </Reanimated.View>
          ) : null}

          <View style={styles.divider} />
          <View style={styles.row}>
            <View style={styles.rowIcon}>
              <SymbolView name={SYMBOLS.active} size={18} tintColor={theme.primaryStrong} />
            </View>
            <View style={styles.rowTextCol}>
              <ThemedText style={styles.rowLabel}>Aktif</ThemedText>
              <ThemedText style={styles.rowSub}>
                {form.is_active ? 'Berbunyi sesuai jadwal' : 'Disimpan tanpa berbunyi'}
              </ThemedText>
            </View>
            <Switch
              value={form.is_active}
              disabled={saving}
              onValueChange={(v) => setForm((f) => ({ ...f, is_active: v }))}
              trackColor={{ false: theme.backgroundSelected, true: theme.primary }}
              thumbColor={Platform.OS === 'android' ? theme.backgroundElement : undefined}
              accessibilityLabel={form.is_active ? 'Nonaktifkan alarm' : 'Aktifkan alarm'}
            />
          </View>
        </View>

        {alarm ? (
          <Pressable
            disabled={saving}
            onPress={() => onDelete(alarm)}
            accessibilityRole="button"
            accessibilityLabel="Hapus alarm"
            style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}>
            <SymbolView name={SYMBOLS.trash} size={18} tintColor={theme.danger} />
            <ThemedText style={styles.deleteText}>Hapus alarm</ThemedText>
          </Pressable>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Public component — thin Modal wrapper, no state.
//
// contentKey changes whenever the modal opens for a different alarm (or new),
// which remounts AlarmEditorContent and re-runs its lazy state initialisers.
// ---------------------------------------------------------------------------

/** Create/edit bottom sheet. All controls are pure React Native (Expo Go safe). */
export function AlarmEditorModal({ visible, alarm, draft, saving, onClose, onDraftChange, onSave, onDelete }: AlarmEditorModalProps) {
  const styles = useEditorStyles();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const reduceMotion = useReducedMotion();

  // Key changes whenever the modal opens for a different alarm (or as new).
  // React remounts AlarmEditorContent, re-running its lazy initialisers —
  // no useEffect needed to reset form state between opens.
  const contentKey = visible ? (alarm?.id ?? draft?.alarmId ?? 'new') : 'closed';
  const contentKind = contentKey === 'closed' ? 'closed' : alarm ? 'existing' : 'new';

  useEffect(() => {
    diag('editor.wrapper.contentKey.changed', {
      contentKey: contentKind,
    });
  }, [contentKey, contentKind]);

  const translateY = useSharedValue(windowHeight);
  const scrim = useSharedValue(0);

  useEffect(() => {
    if (!visible) return;
    if (reduceMotion) {
      translateY.set(0);
      scrim.set(1);
      return;
    }
    translateY.set(windowHeight);
    scrim.set(0);
    translateY.set(withSpring(0, { damping: 26, stiffness: 260, mass: 0.9 }));
    scrim.set(withTiming(1, { duration: 200 }));
  }, [visible, reduceMotion, windowHeight, translateY, scrim]);

  // Swipe down on the sheet header dismisses through the same onClose as Batal / back.
  const dismissPan = Gesture.Pan()
    .enabled(!saving)
    .activeOffsetY(10)
    .failOffsetX([-20, 20])
    .onUpdate((event) => {
      translateY.set(Math.max(0, event.translationY));
    })
    .onEnd((event) => {
      if (event.translationY > 140 || event.velocityY > 1200) {
          if (reduceMotion) {
            runOnJS(onClose)();
            return;
          }
        translateY.set(withTiming(windowHeight, { duration: 180 }, (finished) => {
          if (finished) runOnJS(onClose)();
        }));
        return;
      }
        translateY.set(reduceMotion ? 0 : withSpring(0, { damping: 26, stiffness: 320 }));
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrim.value }));

  return (
    <Modal
      visible={visible}
      animationType="none"
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.modalRoot}>
        <Reanimated.View pointerEvents="none" style={[styles.scrim, scrimStyle]} />
        <Reanimated.View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            { height: windowHeight - insets.top - Spacing.three, width: Math.min(windowWidth, MAX_SHEET_WIDTH) },
            sheetStyle,
          ]}>
          {visible ? <AlarmEditorContent
            key={contentKey}
            alarm={alarm}
            draft={draft}
            saving={saving}
            insets={insets}
            theme={theme}
            dragGesture={dismissPan}
            onClose={onClose}
            onDraftChange={onDraftChange}
            onSave={onSave}
            onDelete={onDelete}
          /> : null}
        </Reanimated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TimeStepperRow({
  label,
  value,
  saving,
  minusDisabled,
  plusDisabled,
  onMinus,
  onPlus,
}: {
  label: string;
  value: string;
  saving: boolean;
  minusDisabled?: boolean;
  plusDisabled?: boolean;
  onMinus: () => void;
  onPlus: () => void;
}) {
  const styles = useEditorStyles();
  return (
    <View style={styles.stepperRow}>
      <ThemedText style={styles.panelLabel}>{label}</ThemedText>
      <View style={styles.stepperGroup}>
        <StepperButton label="Kurangi" onPress={onMinus} disabled={saving || minusDisabled} minus />
        <ThemedText style={styles.stepperValue} accessibilityLiveRegion="polite">{value}</ThemedText>
        <StepperButton label="Tambah" onPress={onPlus} disabled={saving || plusDisabled} />
      </View>
    </View>
  );
}

function StepperButton({
  label,
  onPress,
  disabled,
  minus,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  minus?: boolean;
}) {
  const theme = useTheme();
  const styles = useEditorStyles();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.stepper, pressed && styles.pressed, disabled && styles.disabled]}>
      <SymbolView name={minus ? SYMBOLS.minus : SYMBOLS.plus} size={18} tintColor={theme.text} />
    </Pressable>
  );
}

/** Large tap target with press-and-hold auto-repeat; exposed as an adjustable control. */
function TimeStepper({
  label,
  unit,
  value,
  disabled,
  onStep,
}: {
  label: string;
  unit: string;
  value: number;
  disabled: boolean;
  onStep: (delta: number) => void;
}) {
  const styles = useEditorStyles();
  const display = String(value).padStart(2, '0');
  return (
    <View style={styles.stepperCol}>
      <ThemedText style={styles.stepperCaption} importantForAccessibility="no">{label}</ThemedText>
      <RepeatButton direction="up" label={`Tambah ${unit}`} disabled={disabled} onStep={() => onStep(1)} />
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: `${value} ${unit}` }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event) => onStep(event.nativeEvent.actionName === 'increment' ? 1 : -1)}
        style={styles.timeValueBox}>
        <ThemedText style={styles.timeValue}>{display}</ThemedText>
      </View>
      <RepeatButton direction="down" label={`Kurangi ${unit}`} disabled={disabled} onStep={() => onStep(-1)} />
    </View>
  );
}

function RepeatButton({
  direction,
  label,
  disabled,
  onStep,
}: {
  direction: 'up' | 'down';
  label: string;
  disabled: boolean;
  onStep: () => void;
}) {
  const theme = useTheme();
  const styles = useEditorStyles();
  const timers = useRef<{
    delay: ReturnType<typeof setTimeout> | null;
    repeat: ReturnType<typeof setInterval> | null;
    fired: boolean;
  }>({ delay: null, repeat: null, fired: false });
  const stop = useCallback(() => {
    if (timers.current.delay) clearTimeout(timers.current.delay);
    if (timers.current.repeat) clearInterval(timers.current.repeat);
    timers.current.delay = null;
    timers.current.repeat = null;
  }, []);
  useEffect(() => stop, [stop]);
  useEffect(() => { if (disabled) stop(); }, [disabled, stop]);

  return (
    <Pressable
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      onPressIn={() => {
        stop();
        timers.current.fired = false;
        timers.current.delay = setTimeout(() => {
          timers.current.fired = true;
          onStep();
          timers.current.repeat = setInterval(onStep, 90);
        }, 400);
      }}
      onPressOut={stop}
      onPress={() => { if (!timers.current.fired) onStep(); }}
      style={({ pressed }) => [styles.arrowButton, pressed && styles.arrowPressed, disabled && styles.disabled]}>
      <SymbolView name={direction === 'up' ? SYMBOLS.up : SYMBOLS.down} size={22} tintColor={theme.textSecondary} />
    </Pressable>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  disabled,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const styles = useEditorStyles();
  return (
    <View style={styles.segment} accessibilityRole="radiogroup">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            style={({ pressed }) => [styles.segmentItem, selected && styles.segmentItemSelected, pressed && !selected && styles.segmentPressed]}>
            <ThemedText
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
              style={[styles.segmentText, selected && styles.segmentTextSelected]}>
              {option.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

function ListRow({
  icon,
  label,
  value,
  expanded,
  disabled,
  onPress,
}: {
  icon: SymbolName;
  label: string;
  value: string | ReactElement;
  expanded: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const styles = useEditorStyles();
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded, disabled }}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <View style={styles.rowIcon}>
        <SymbolView name={icon} size={18} tintColor={theme.primaryStrong} />
      </View>
      <ThemedText style={styles.rowLabel}>{label}</ThemedText>
      <View style={styles.rowValueWrap}>
        {typeof value === 'string' ? <ThemedText numberOfLines={1} style={styles.rowValue}>{value}</ThemedText> : value}
      </View>
      <SymbolView name={expanded ? SYMBOLS.up : SYMBOLS.down} size={16} tintColor={theme.textSecondary} />
    </Pressable>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function makeStyles(t: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    flex: { flex: 1 },
    modalRoot: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
    scrim: { ...StyleSheet.absoluteFill, backgroundColor: SCRIM },
    sheet: {
      backgroundColor: t.background,
      borderTopLeftRadius: Radius.block + 8,
      borderTopRightRadius: Radius.block + 8,
      overflow: 'hidden',
    },
    header: {
      paddingTop: Spacing.two,
      paddingBottom: Spacing.two,
      paddingHorizontal: Spacing.three,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      backgroundColor: t.background,
    },
    handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: t.border, marginBottom: Spacing.two },
    headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
    headerButton: { minHeight: 48, minWidth: 64, justifyContent: 'center' },
    headerCancel: { color: t.primaryStrong, fontSize: 17, fontWeight: '600' },
    headerTitle: { flex: 1, textAlign: 'center', color: t.text, fontSize: 17, fontWeight: '700' },
    saveButton: {
      minHeight: 40,
      minWidth: 84,
      paddingHorizontal: Spacing.three,
      borderRadius: Radius.chip,
      backgroundColor: t.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    saveText: { color: t.onPrimary, fontSize: 16, fontWeight: '700' },
    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.two,
      marginHorizontal: Spacing.three,
      marginTop: Spacing.two,
      padding: Spacing.three,
      borderRadius: Radius.control,
      backgroundColor: t.dangerSoft,
    },
    errorText: { flex: 1, color: t.danger, fontSize: 14, lineHeight: 20, fontWeight: '600' },
    scrollContent: { paddingHorizontal: Spacing.three, paddingTop: Spacing.three, gap: Spacing.four },

    timeBlock: { alignItems: 'center', gap: Spacing.three },
    timeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
    timeColon: { color: t.textSecondary, fontSize: 48, lineHeight: 56, fontWeight: '700', marginTop: Spacing.four },
    stepperCol: { alignItems: 'center', gap: Spacing.one },
    stepperCaption: { color: t.textSecondary, fontSize: 13, fontWeight: '600' },
    arrowButton: { width: 112, height: 48, borderRadius: Radius.control, alignItems: 'center', justifyContent: 'center' },
    arrowPressed: { backgroundColor: t.backgroundSelected },
    timeValueBox: {
      width: 112,
      height: 88,
      borderRadius: Radius.block,
      backgroundColor: t.backgroundElement,
      borderWidth: 1,
      borderColor: t.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    timeValue: { color: t.text, fontSize: 56, lineHeight: 64, fontWeight: '700', fontVariant: ['tabular-nums'] },
    previewPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.two,
      paddingHorizontal: Spacing.three,
      paddingVertical: Spacing.two,
      borderRadius: Radius.chip,
      backgroundColor: t.primarySoft,
    },
    previewText: { color: t.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
    pastText: { color: t.danger, fontSize: 14, fontWeight: '600', textAlign: 'center' },
    quickRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: Spacing.two },
    quickChip: {
      minHeight: 40,
      paddingHorizontal: Spacing.three,
      borderRadius: Radius.chip,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.backgroundElement,
      justifyContent: 'center',
    },
    quickText: { color: t.primaryStrong, fontSize: 14, fontWeight: '600' },

    section: { gap: Spacing.two },
    sectionLabel: { color: t.textSecondary, fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', paddingHorizontal: Spacing.one },
    input: {
      minHeight: 52,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: Radius.control,
      paddingHorizontal: Spacing.three,
      fontSize: 16,
      color: t.text,
      backgroundColor: t.backgroundElement,
    },
    segment: {
      flexDirection: 'row',
      padding: 4,
      gap: 4,
      borderRadius: Radius.control,
      backgroundColor: t.backgroundSelected,
    },
    segmentItem: { flex: 1, minHeight: 44, borderRadius: Radius.control - 4, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.one },
    segmentItemSelected: {
      backgroundColor: t.backgroundElement,
      shadowColor: '#000',
      shadowOpacity: 0.08,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    },
    segmentPressed: { opacity: 0.7 },
    segmentText: { color: t.textSecondary, fontSize: 14, fontWeight: '600' },
    segmentTextSelected: { color: t.text, fontWeight: '700' },
    daysBlock: { gap: Spacing.two },
    daysRow: { flexDirection: 'row', gap: Spacing.one },
    dayButton: {
      flex: 1,
      height: 48,
      borderRadius: Radius.control,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.backgroundElement,
      alignItems: 'center',
      justifyContent: 'center',
    },
    daySelected: { backgroundColor: t.primary, borderColor: t.primary },
    dayText: { color: t.textSecondary, fontSize: 15, fontWeight: '700' },
    dayTextSelected: { color: t.onPrimary },
    inlineLink: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.two },
    inlineLinkText: { color: t.primaryStrong, fontSize: 14, fontWeight: '600' },

    group: {
      borderRadius: Radius.block,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.backgroundElement,
      overflow: 'hidden',
    },
    row: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: Spacing.three, paddingHorizontal: Spacing.three },
    rowPressed: { backgroundColor: t.backgroundSelected },
    rowIcon: { width: 32, height: 32, borderRadius: Radius.control - 4, backgroundColor: t.primarySoft, alignItems: 'center', justifyContent: 'center' },
    rowLabel: { color: t.text, fontSize: 16, fontWeight: '600' },
    rowTextCol: { flex: 1, gap: 2 },
    rowSub: { color: t.textSecondary, fontSize: 13 },
    rowValueWrap: { flex: 1, alignItems: 'flex-end' },
    rowValue: { color: t.textSecondary, fontSize: 15 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginLeft: Spacing.three + 32 + Spacing.three },
    panel: { paddingHorizontal: Spacing.three, paddingBottom: Spacing.three, gap: Spacing.three },
    panelFlush: { paddingBottom: Spacing.two },
    panelLabel: { color: t.text, fontSize: 15, fontWeight: '600' },
    previewCard: {
      gap: Spacing.two,
      padding: Spacing.three,
      borderRadius: Radius.control,
      borderWidth: 1,
      borderLeftWidth: 3,
      borderColor: t.border,
      borderLeftColor: t.primaryStrong,
      backgroundColor: t.background,
    },
    previewHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    previewEyebrow: { color: t.primaryStrong, fontSize: 11, fontWeight: '800', letterSpacing: 0.7 },
    previewLevel: {
      overflow: 'hidden',
      paddingHorizontal: Spacing.two,
      paddingVertical: Spacing.half,
      borderRadius: Radius.chip,
      backgroundColor: t.primarySoft,
      color: t.primaryStrong,
      fontSize: 12,
      fontWeight: '700',
    },
    previewDescription: { color: t.textSecondary, fontSize: 13, lineHeight: 18 },
    previewList: { gap: Spacing.one, marginTop: Spacing.one },
    previewRow: {
      minHeight: 38,
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.two,
      paddingHorizontal: Spacing.two,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
      borderRadius: Radius.control - 4,
      backgroundColor: t.backgroundElement,
    },
    previewNumber: { width: 24, color: t.primaryStrong, fontSize: 11, fontWeight: '800' },
    previewExpression: { color: t.text, fontSize: 15, fontWeight: '600' },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
    chip: {
      minHeight: 44,
      paddingHorizontal: Spacing.three,
      borderRadius: Radius.chip,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    chipFlex: { flexGrow: 1, minWidth: 56 },
    chipSelected: { backgroundColor: t.primary, borderColor: t.primary },
    chipText: { color: t.text, fontSize: 14, fontWeight: '600' },
    chipTextSelected: { color: t.onPrimary, fontWeight: '700' },
    optionRow: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: Spacing.two,
      paddingLeft: Spacing.three + 32 + Spacing.three,
      paddingRight: Spacing.three,
    },
    optionText: { flex: 1, color: t.text, fontSize: 15 },
    optionTextSelected: { color: t.primaryStrong, fontWeight: '700' },
    hint: {
      color: t.textSecondary,
      fontSize: 13,
      lineHeight: 18,
      paddingLeft: Spacing.three + 32 + Spacing.three,
      paddingRight: Spacing.three,
      paddingTop: Spacing.one,
    },

    stepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.three },
    stepperGroup: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
    stepper: {
      width: 48,
      height: 48,
      borderRadius: Radius.control,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepperValue: { color: t.text, fontSize: 22, lineHeight: 28, fontWeight: '700', fontVariant: ['tabular-nums'], minWidth: 40, textAlign: 'center' },

    deleteButton: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Spacing.two,
      borderRadius: Radius.block,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.backgroundElement,
    },
    deleteText: { color: t.danger, fontSize: 16, fontWeight: '700' },
    pressed: { opacity: 0.75 },
    disabled: { opacity: 0.45 },
  });
}

function useEditorStyles() {
  const theme = useTheme();
  return useMemo(() => makeStyles(theme), [theme]);
}
