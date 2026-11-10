import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Accent, AlarmPalette, Danger, Radius, Spacing } from '@/constants/theme';
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
    describeAlarmSchedule,
    formatTimeID,
    formatCountdown,
    nextOccurrenceForAlarm,
    nextOnceOccurrence,
    parseRepeatDays,
} from '@/lib/home-data';
import {
  DEFAULT_ALARM_RINGTONE,
  SYSTEM_ALARM_RINGTONE,
  getAlarmRingtone,
  type AlarmRingtone,
} from '@/lib/alarm-ringtones';
import { previewRingtone, stopRingtonePreview } from '@/lib/ringtone-preview';
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

const DAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

const QUICK_ADDS: { label: string; minutes: number }[] = [
  { label: '+10 mnt', minutes: 10 },
  { label: '+30 mnt', minutes: 30 },
  { label: '+1 jam', minutes: 60 },
];

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
  onClose,
  onDraftChange,
  onSave,
  onDelete,
}: AlarmEditorContentProps) {
  // Lazy initialisers: evaluated once on mount (key controls when that is).
  const matchesDraft = !!draft && draft.alarmId === (alarm?.id ?? null);
  const [form, setForm] = useState<AlarmForm>(() => draft?.alarmId === (alarm?.id ?? null) ? draft.form : formFromAlarm(alarm));
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
  const [challengeExpanded, setChallengeExpanded] = useState(false);
  const [soundExpanded, setSoundExpanded] = useState(false);
  const [snoozeExpanded, setSnoozeExpanded] = useState(false);
  const [quickAddExpanded, setQuickAddExpanded] = useState(false);
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
    void getAlarmRingtone(ringtoneAlarmId).then((value) => {
      if (active) {
        setRingtone(value);
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
    stopRingtonePreview();
    setRingtone(value);
    if (value.kind === 'custom' && value.uri) void previewRingtone(value.uri);
    if (value.kind === 'mathwake') void previewRingtone(MATHWAKE_ALARM_SOUND);
    if (value.kind === 'system') {
      const uri = await getNativeDefaultAlarmRingtoneUri();
      if (uri) void previewRingtone(uri);
    }
  }

  const [hourStr, minuteStr] = form.time.split(':');

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
    if (saving) return;
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

  const hour24 = Number(hourStr);
  const hour12 = hour24 % 12 || 12;
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const setHour12 = (next: number) => setForm((f) => {
    const current = Number(f.time.slice(0, 2));
    const normalized = ((next - 1 + 12) % 12) + 1;
    const value = (normalized % 12) + (current >= 12 ? 12 : 0);
    return { ...f, time: `${String(value).padStart(2, '0')}:${f.time.slice(3)}` };
  });
  const setPeriod = (next: 'AM' | 'PM') => setForm((f) => {
    const h = Number(f.time.slice(0, 2));
    const value = next === 'PM' ? (h % 12) + 12 : h % 12;
    return { ...f, time: `${String(value).padStart(2, '0')}:${f.time.slice(3)}` };
  });

  return (
    <View style={[styles.screen, { backgroundColor: AlarmPalette.cream, paddingTop: insets.top }]}>
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scrollContent}>
        <View style={styles.topBar}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Tutup editor" style={styles.closeButton}><ThemedText style={styles.closeGlyph}>{'\u00D7'}</ThemedText></Pressable>
          <View style={styles.headingWrap}>
            <TextInput value={form.title} onChangeText={(title) => setForm((f) => ({ ...f, title: title.slice(0, 40) }))} maxLength={40} editable={!saving} placeholder={alarm ? 'ALARM' : 'ALARM 1'} placeholderTextColor={Accent} accessibilityLabel="Judul alarm, opsional" style={styles.alarmTitleInput} returnKeyType="done" />
            <ThemedText style={styles.heading}>Choose Time</ThemedText>
          </View>
          <View style={styles.periodToggle}>{(['AM', 'PM'] as const).map((value) => <Pressable key={value} onPress={() => setPeriod(value)} accessibilityRole="button" accessibilityState={{ selected: period === value }} style={[styles.periodOption, period === value && styles.periodSelected]}><ThemedText style={[styles.periodText, period === value && styles.periodTextSelected]}>{value}</ThemedText></Pressable>)}</View>
        </View>

        {/* 1. Waktu alarm */}
        <View style={styles.timeColumns} accessibilityLabel={`Waktu ${form.time}`}>
          <WheelColumn label="HOURS" value={String(hour12).padStart(2, '0')} onPrevious={() => setHour12(hour12 - 1)} onNext={() => setHour12(hour12 + 1)} />
          <WheelColumn label="MINUTES" value={minuteStr} onPrevious={() => setForm((f) => ({ ...f, time: shiftTime(f.time, -1) }))} onNext={() => setForm((f) => ({ ...f, time: shiftTime(f.time, 1) }))} />
        </View>
        <Pressable onPress={() => setQuickAddExpanded((value) => !value)} accessibilityRole="button" accessibilityState={{ expanded: quickAddExpanded }} style={styles.quickAddTrigger}><ThemedText style={styles.quickAddText}>Atur cepat {quickAddExpanded ? '-' : '+'}</ThemedText></Pressable>
        {quickAddExpanded ? <View style={styles.quickAddRow}>{QUICK_ADDS.map(({ label, minutes }) => <Pressable key={label} disabled={saving} onPress={() => setForm((f) => ({ ...f, time: shiftTime(nowTime(), minutes) }))} accessibilityRole="button" accessibilityLabel={`Atur ${label} dari sekarang`} style={styles.quickAddChip}><ThemedText style={styles.quickAddText}>{label}</ThemedText></Pressable>)}</View> : null}

        {/* Small neutral next-time note, not a selectable card. */}
        {kind === 'once' ? (
          preview ? (
            <View style={styles.countdownPill}><ThemedText style={styles.countdownIcon}>{'\u231A'}</ThemedText><ThemedText style={styles.countdownText}>Rings in {formatCountdown(preview, previewNow)} {describeAlarmDay(preview, previewNow)}</ThemedText></View>
          ) : (
            <ThemedText type="small" style={[styles.nextNote, { color: Danger }]}>
              Waktu alarm sudah lewat. Pilih waktu baru untuk melanjutkan.
            </ThemedText>
          )
        ) : preview ? (
          <View style={styles.countdownPill}><ThemedText style={styles.countdownIcon}>{'\u231A'}</ThemedText><ThemedText style={styles.countdownText}>Rings in {formatCountdown(preview, previewNow)} {describeAlarmDay(preview, previewNow)}</ThemedText></View>
        ) : null}

        <View style={[styles.repeatCard, { backgroundColor: AlarmPalette.white, borderColor: AlarmPalette.border }]}>
          <View style={styles.repeatHeader}>
            <View style={styles.cardTitleLine}><View style={styles.repeatIcon}><ThemedText style={styles.cardIcon}>{'\u21BB'}</ThemedText></View><ThemedText style={styles.cardTitle}>REPEAT</ThemedText></View>
            <View style={styles.presetGroup}>
              <Pressable onPress={() => setKindOption('once')} accessibilityRole="radio" accessibilityState={{ selected: kind === 'once' }} style={[styles.miniPill, kind === 'once' && styles.miniPillActive]}><ThemedText style={[styles.miniPillText, kind === 'once' && styles.miniPillTextActive]}>Sekali saja</ThemedText></Pressable>
              <Pressable onPress={() => applyPreset([1, 2, 3, 4, 5])} accessibilityRole="radio" accessibilityState={{ selected: form.days.length === 5 && [1, 2, 3, 4, 5].every((day) => form.days.includes(day)) }} style={[styles.miniPill, form.days.length === 5 && [1, 2, 3, 4, 5].every((day) => form.days.includes(day)) && styles.miniPillActive]}><ThemedText style={[styles.miniPillText, form.days.length === 5 && [1, 2, 3, 4, 5].every((day) => form.days.includes(day)) && styles.miniPillTextActive]}>Mon - Fri</ThemedText></Pressable>
            </View>
          </View>
          <View style={styles.daysRow}>{DAY_BUTTONS.map(({ value, label }, index) => {
            const selected = kind !== 'once' && form.days.includes(value);
            return <Pressable key={value} disabled={saving} onPress={() => toggleDay(value)} accessibilityRole="button" accessibilityLabel={`${label}${selected ? ', dipilih' : ''}`} accessibilityState={{ selected }} style={[styles.dayButton, selected ? styles.daySelected : styles.dayIdle]}><ThemedText style={[styles.dayText, selected && styles.dayTextSelected]}>{DAY_INITIALS[index]}</ThemedText></Pressable>;
          })}</View>
          <View style={styles.extraPresets}>{WEEKDAY_PRESETS.filter((item) => item.key === 'daily' || item.key === 'weekend').map(({ key, label, days }) => <Pressable key={key} onPress={() => applyPreset(days)} accessibilityRole="button" style={styles.extraPreset}><ThemedText style={styles.extraPresetText}>{label}</ThemedText></Pressable>)}</View>
        </View>

        <View style={styles.smallCardsRow}>
          <Pressable disabled={saving} onPress={() => setSnoozeExpanded((value) => !value)} accessibilityRole="button" accessibilityState={{ expanded: snoozeExpanded }} style={[styles.smallCard, { backgroundColor: AlarmPalette.white, borderColor: AlarmPalette.border }]}>
            <View style={styles.cardTitleLine}><ThemedText style={styles.cardIcon}>{'\u23F2'}</ThemedText><ThemedText style={styles.cardTitle}>Snooze</ThemedText></View>
            <View style={styles.snoozeSummary}><ThemedText style={styles.cardSub}>Interval</ThemedText><ThemedText style={styles.snoozeValue}>{form.snooze_minutes} min</ThemedText></View>
          </Pressable>
          <Pressable onPress={() => setSoundExpanded((value) => !value)} accessibilityRole="button" accessibilityState={{ expanded: soundExpanded }} style={[styles.smallCard, { backgroundColor: AlarmPalette.white, borderColor: AlarmPalette.border }]}>
            <View style={styles.cardTitleLine}><ThemedText style={styles.cardIcon}>{'\u266B'}</ThemedText><ThemedText style={styles.cardTitle}>Sound</ThemedText><ThemedText style={styles.chevron}>{'\u203A'}</ThemedText></View>
            <ThemedText numberOfLines={1} style={styles.cardSub}>{ringtone.name}</ThemedText>
          </Pressable>
        </View>

        {snoozeExpanded ? <View style={[styles.expandedCard, { backgroundColor: AlarmPalette.white, borderColor: AlarmPalette.border }]}>
          <ThemedText type="smallBold" style={styles.sectionTitle}>Interval Snooze</ThemedText>
          <View style={styles.chipRow}>{SNOOZE_INTERVALS.map((minutes) => {
            const selected = form.snooze_minutes === minutes;
            return <Pressable key={minutes} disabled={saving} onPress={() => setForm((current) => ({ ...current, snooze_minutes: minutes }))} accessibilityRole="radio" accessibilityLabel={`${minutes} menit`} accessibilityState={{ selected }} style={[styles.snoozeOption, { backgroundColor: selected ? Accent : theme.backgroundElement }]}><ThemedText type="small" style={selected ? styles.chipTextSelected : { color: theme.textSecondary }}>{minutes} min</ThemedText></Pressable>;
          })}</View>
        </View> : null}

{soundExpanded ? <View style={[styles.expandedCard, { backgroundColor: AlarmPalette.white, borderColor: AlarmPalette.border }]}>
         <ThemedText type="smallBold" style={styles.sectionTitle}>Suara alarm</ThemedText>
         <View style={styles.chipRow}>
           {[DEFAULT_ALARM_RINGTONE, SYSTEM_ALARM_RINGTONE].map((option) => (
             <Pressable
               key={option.kind}
               disabled={saving}
               onPress={() => void chooseRingtone(option)}
               accessibilityRole="radio"
               accessibilityState={{ selected: ringtone.kind === option.kind }}
               style={[styles.chipWide, { backgroundColor: ringtone.kind === option.kind ? Accent : theme.backgroundElement }]}>
               <ThemedText type="small" style={ringtone.kind === option.kind ? styles.chipTextSelected : { color: theme.textSecondary }}>
                 {option.name}
               </ThemedText>
             </Pressable>
           ))}
         </View>
         <Pressable
           disabled={saving}
            onPress={async () => {
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
            }}
           accessibilityRole="button"
           accessibilityLabel="Pilih audio kustom"
           style={[styles.chipWide, { backgroundColor: theme.backgroundElement }]}>
           <ThemedText type="small" style={{ color: theme.textSecondary }}>
             {ringtone.kind === 'custom' ? ringtone.name : 'Pilih audio kustom'}
           </ThemedText>
         </Pressable>
         <ThemedText type="small" themeColor="textSecondary" style={styles.fieldHint}>
           Default MathWake digunakan jika akses audio kustom dicabut atau tidak valid.
         </ThemedText>
         </View> : null}

                {/* 3. Tantangan matematika */}
        <Pressable onPress={() => setChallengeExpanded((value) => !value)} accessibilityRole="button" accessibilityState={{ expanded: challengeExpanded }} style={[styles.challengeCard, { backgroundColor: AlarmPalette.white, borderColor: AlarmPalette.border }]}>
          <View style={styles.challengeIcon}><ThemedText style={styles.challengeGlyph}>+/-</ThemedText></View>
          <View style={styles.challengeCopy}><View style={styles.challengeTitleLine}><ThemedText style={styles.cardTitle}>Math Wakeup Task</ThemedText><ThemedText style={styles.requiredBadge}>REQUIRED</ThemedText></View><ThemedText style={styles.cardSub}>Level {form.difficulty} · {form.question_count} soal</ThemedText></View>
          <ThemedText style={styles.editText}>{challengeExpanded ? 'Tutup' : 'Edit'} ›</ThemedText>
        </Pressable>
        {challengeExpanded ? <View style={[styles.expandedCard, { backgroundColor: AlarmPalette.white, borderColor: AlarmPalette.border }]}>
        <ThemedText type="smallBold" style={styles.sectionTitle}>Tantangan matematika</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.fieldHint}>Level dan jumlah soal tersimpan untuk alarm ini.</ThemedText>
        <View style={styles.chipRow}>
          {DIFFICULTY_OPTIONS.map((option) => {
            const selected = form.difficulty === option;
            return (
              <Pressable
                key={option}
                disabled={saving}
                onPress={() => setForm((f) => ({ ...f, difficulty: option }))}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Level ${option}`}
                style={[
                  styles.chipWide,
                  { backgroundColor: selected ? Accent : theme.backgroundElement },
                ]}>
                <ThemedText
                  type="small"
                  style={selected ? styles.chipTextSelected : { color: theme.textSecondary }}>
                  {option}
                </ThemedText>
              </Pressable>
            );
          })}
        </View>
        <TimeStepperRow
          label="Soal"
          value={String(form.question_count)}
          saving={saving}
          minusDisabled={form.question_count <= 1}
          plusDisabled={form.question_count >= 10}
          onMinus={() => setForm((f) => ({ ...f, question_count: f.question_count - 1 }))}
          onPlus={() => setForm((f) => ({ ...f, question_count: f.question_count + 1 }))}
        />
        </View> : null}

         {/* 6. Status dan ringkasan */}
        <View style={[styles.statusCard, { backgroundColor: AlarmPalette.white, borderColor: AlarmPalette.border }]}>
          <View><ThemedText style={styles.cardTitle}>Status</ThemedText><ThemedText style={styles.cardSub}>{form.is_active ? 'Alarm' : 'Nonaktif'}</ThemedText></View>
          <Switch
            value={form.is_active}
            disabled={saving}
            onValueChange={(v) => setForm((f) => ({ ...f, is_active: v }))}
            trackColor={{ false: theme.backgroundSelected, true: Accent }}
            accessibilityLabel={form.is_active ? 'Nonaktifkan alarm' : 'Aktifkan alarm'}
          />
        </View>
        <View style={[styles.summaryBox, { backgroundColor: theme.backgroundElement }]}>
          <ThemedText type="small" style={styles.summaryLine}>
            {formatTimeID(form.time)} • {describeAlarmSchedule({ is_recurring: form.is_recurring, days: dayNumbersToTokens(form.days) })}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {form.question_count} soal • Level {form.difficulty} • {form.is_active ? 'Aktif' : 'Nonaktif'}
          </ThemedText>
        </View>

        {localError ? (
          <ThemedText type="small" style={styles.errorText}>{localError}</ThemedText>
        ) : null}

        {alarm ? (
          <Pressable
            disabled={saving}
            onPress={() => onDelete(alarm)}
            accessibilityRole="button"
            accessibilityLabel="Hapus alarm"
            style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}>
            <ThemedText type="small" style={styles.deleteText}>Hapus alarm</ThemedText>
          </Pressable>
        ) : null}

        <Pressable
          disabled={saving}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Batal"
          style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}>
          <ThemedText type="small" themeColor="textSecondary">Batal</ThemedText>
        </Pressable>
      </ScrollView>
      <View style={[styles.bottomAction, { paddingBottom: Math.max(insets.bottom, Spacing.two) }]}>
        <Pressable disabled={saving} onPress={onClose} accessibilityRole="button" accessibilityLabel="Batal" style={styles.bottomCancel}><ThemedText style={styles.closeGlyph}>{'\u00D7'}</ThemedText></Pressable>
        <Pressable disabled={saving} onPress={handleSave} accessibilityRole="button" accessibilityLabel="Simpan alarm" style={({ pressed }) => [styles.saveButton, pressed && styles.pressed, saving && styles.disabled]}><ThemedText style={styles.saveText}>{'\u2713'}  {saving ? 'Menyimpan...' : 'Save Alarm'}</ThemedText></Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Public component — thin Modal wrapper, no state.
//
// contentKey changes whenever the modal opens for a different alarm (or new),
// which remounts AlarmEditorContent and re-runs its lazy state initialisers.
// ---------------------------------------------------------------------------

/** Create/edit sheet. All controls are pure React Native (Expo Go safe). */
export function AlarmEditorModal({ visible, alarm, draft, saving, onClose, onDraftChange, onSave, onDelete }: AlarmEditorModalProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

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

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <View style={styles.backdrop}>
        {visible ? <AlarmEditorContent
          key={contentKey}
          alarm={alarm}
          draft={draft}
          saving={saving}
          insets={insets}
          theme={theme}
          onClose={onClose}
          onDraftChange={onDraftChange}
          onSave={onSave}
          onDelete={onDelete}
        /> : null}
      </View>
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
  return (
    <View style={styles.stepperRow}>
      <ThemedText type="small" style={styles.stepperLabel}>{label}</ThemedText>
      <View style={styles.stepperGroup}>
        <StepperButton label="-" onPress={onMinus} disabled={saving || minusDisabled} minus />
        <ThemedText style={styles.stepperValue}>{value}</ThemedText>
        <StepperButton label="+" onPress={onPlus} disabled={saving || plusDisabled} />
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
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={minus ? 'Kurangi' : 'Tambah'}
      style={({ pressed }) => [
        styles.stepper,
        { backgroundColor: theme.backgroundElement },
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}>
      <ThemedText type="smallBold" style={{ color: theme.text }}>{label}</ThemedText>
    </Pressable>
  );
}

function WheelColumn({ label, value, onPrevious, onNext }: { label: string; value: string; onPrevious: () => void; onNext: () => void }) {
  const number = Number(value);
  const previous = label === 'HOURS' ? String(((number + 10) % 12) + 1).padStart(2, '0') : String((number + 59) % 60).padStart(2, '0');
  const next = label === 'HOURS' ? String((number % 12) + 1).padStart(2, '0') : String((number + 1) % 60).padStart(2, '0');
  return (
    <View style={styles.wheelColumn}>
      <ThemedText style={styles.wheelLabel}>{label}</ThemedText>
      <Pressable onPress={onPrevious} accessibilityRole="button" accessibilityLabel={`Kurangi ${label === 'HOURS' ? 'jam' : 'menit'}`} style={styles.wheelNeighbour}><ThemedText style={styles.wheelFaded}>{previous}</ThemedText></Pressable>
      <View style={styles.wheelSelected}><ThemedText style={[styles.wheelValue, label === 'HOURS' && styles.wheelHour]}>{value}</ThemedText></View>
      <Pressable onPress={onNext} accessibilityRole="button" accessibilityLabel={`Tambah ${label === 'HOURS' ? 'jam' : 'menit'}`} style={styles.wheelNeighbour}><ThemedText style={styles.wheelFaded}>{next}</ThemedText></Pressable>
      <ThemedText style={[styles.wheelFaded, styles.wheelLowest]}>{label === 'HOURS' ? String((number % 12) + 2).padStart(2, '0') : String((number + 2) % 60).padStart(2, '0')}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: AlarmPalette.cream,
  },
  backdropPress: {
    flex: 1,
  },
  sheet: {
    flex: 1,
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: 0,
  },
  screen: { flex: 1, width: '100%' },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.two, paddingBottom: Spacing.three, gap: Spacing.two },
  topBar: { minHeight: 64, paddingHorizontal: Spacing.three, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  closeButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: AlarmPalette.white, alignItems: 'center', justifyContent: 'center' },
  closeGlyph: { color: AlarmPalette.tertiary, fontSize: 25, lineHeight: 28, fontWeight: '400' },
  headingWrap: { flex: 1, alignItems: 'center' },
  eyebrow: { color: Accent, fontSize: 10, lineHeight: 15, letterSpacing: 1.2, fontWeight: '700', textAlign: 'center' },
  alarmTitleInput: { color: Accent, fontSize: 10, lineHeight: 15, letterSpacing: 1.2, fontWeight: '800', textAlign: 'center', minWidth: 90, padding: 0 },
  heading: { color: AlarmPalette.darkBrown, fontSize: 18, lineHeight: 23, fontWeight: '700' },
  periodToggle: { flexDirection: 'row', borderRadius: Radius.chip, backgroundColor: AlarmPalette.white, padding: 3, minWidth: 80 },
  periodOption: { flex: 1, borderRadius: Radius.chip, paddingHorizontal: 7, paddingVertical: 6, alignItems: 'center' },
  periodSelected: { backgroundColor: Accent },
  periodText: { color: AlarmPalette.tertiary, fontSize: 11, fontWeight: '700' },
  periodTextSelected: { color: AlarmPalette.white },
  nameField: { paddingHorizontal: Spacing.one, gap: 4 },
  timeColumns: { flexDirection: 'row', gap: Spacing.two, paddingHorizontal: Spacing.one },
  wheelColumn: { flex: 1, height: 220, borderRadius: 110, backgroundColor: AlarmPalette.white, alignItems: 'center', justifyContent: 'center', paddingVertical: Spacing.two, overflow: 'hidden' },
  wheelLabel: { color: AlarmPalette.tertiary, fontSize: 10, fontWeight: '700', letterSpacing: 1, marginBottom: Spacing.one },
  wheelNeighbour: { height: 31, justifyContent: 'center', paddingHorizontal: Spacing.four },
  wheelFaded: { color: '#D7C9C0', fontSize: 15, fontWeight: '600', textAlign: 'center' },
  wheelLowest: { opacity: 0.55 },
  wheelSelected: { width: '82%', minHeight: 48, borderRadius: Radius.control, backgroundColor: AlarmPalette.peach, borderWidth: 1, borderColor: '#F3D8CA', alignItems: 'center', justifyContent: 'center' },
  wheelValue: { color: AlarmPalette.darkBrown, fontSize: 27, lineHeight: 32, fontWeight: '700', fontVariant: ['tabular-nums'] },
  wheelHour: { color: Accent, fontSize: 30 },
  countdownPill: { alignSelf: 'center', borderRadius: Radius.chip, backgroundColor: AlarmPalette.white, flexDirection: 'row', alignItems: 'center', gap: Spacing.one, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, marginVertical: Spacing.one },
  countdownIcon: { color: Accent, fontSize: 14 },
  countdownText: { color: AlarmPalette.secondary, fontSize: 11, fontWeight: '600' },
  quickAddTrigger: { alignSelf: 'center', paddingHorizontal: Spacing.two, paddingVertical: 2 },
  quickAddRow: { flexDirection: 'row', justifyContent: 'center', gap: Spacing.two },
  quickAddChip: { borderRadius: Radius.chip, backgroundColor: AlarmPalette.white, paddingHorizontal: Spacing.two, paddingVertical: Spacing.one },
  quickAddText: { color: AlarmPalette.secondary, fontSize: 10, fontWeight: '600' },
  card: { borderWidth: 1, borderRadius: Radius.block, padding: Spacing.three, gap: Spacing.two },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.one },
  cardTitleLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  cardIcon: { color: Accent, fontSize: 16, fontWeight: '700' },
  cardTitle: { color: AlarmPalette.darkBrown, fontSize: 13, fontWeight: '700', flexShrink: 1 },
  presetGroup: { flexDirection: 'row', gap: 5 },
  repeatCard: { borderWidth: 1, borderRadius: Radius.block, padding: Spacing.two, gap: Spacing.two },
  repeatHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.one },
  repeatIcon: { width: 30, height: 30, borderRadius: 9, backgroundColor: AlarmPalette.peach, alignItems: 'center', justifyContent: 'center' },
  miniPill: { borderRadius: Radius.chip, paddingHorizontal: 9, paddingVertical: 6, backgroundColor: AlarmPalette.cream },
  miniPillActive: { backgroundColor: Accent },
  miniPillText: { color: AlarmPalette.secondary, fontSize: 9, fontWeight: '600' },
  miniPillTextActive: { color: AlarmPalette.white },
  daysRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 5 },
  dayButton: { flex: 1, minWidth: 30, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  daySelected: { backgroundColor: Accent },
  dayIdle: { backgroundColor: AlarmPalette.cream },
  dayText: { color: AlarmPalette.secondary, fontSize: 11, fontWeight: '700' },
  dayTextSelected: { color: AlarmPalette.white },
  presetFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.three },
  extraPresets: { flexDirection: 'row', justifyContent: 'flex-end', gap: Spacing.three },
  extraPreset: { minHeight: 20, justifyContent: 'center', paddingHorizontal: 4 },
  extraPresetText: { color: AlarmPalette.tertiary, fontSize: 9, fontWeight: '600' },
  linkText: { color: Accent, fontSize: 11, fontWeight: '600' },
  cardHint: { color: AlarmPalette.secondary, fontSize: 11, lineHeight: 16 },
  smallCardsRow: { flexDirection: 'row', gap: Spacing.two },
  smallCard: { flex: 1, minWidth: 0, minHeight: 84, borderWidth: 1, borderRadius: Radius.block, padding: Spacing.two, justifyContent: 'center', gap: 6 },
  snoozeSummary: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderColor: AlarmPalette.border, paddingTop: 7 },
  snoozeValue: { color: Accent, backgroundColor: AlarmPalette.peach, overflow: 'hidden', borderRadius: 7, paddingHorizontal: 6, paddingVertical: 4, fontSize: 9, fontWeight: '700' },
  snoozeOption: { flex: 1, minWidth: 48, minHeight: 36, borderRadius: Radius.chip, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  cardSub: { color: AlarmPalette.secondary, fontSize: 10, lineHeight: 15 },
  chevron: { marginLeft: 'auto', color: AlarmPalette.tertiary, fontSize: 19 },
  expandedCard: { borderWidth: 1, borderRadius: Radius.block, padding: Spacing.three, gap: Spacing.two },
  soundOption: { minHeight: 38, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: AlarmPalette.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.two },
  challengeCard: { minHeight: 68, borderWidth: 1, borderRadius: Radius.block, padding: Spacing.two, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  challengeIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: AlarmPalette.peach, alignItems: 'center', justifyContent: 'center' },
  challengeGlyph: { color: Accent, fontSize: 16, fontWeight: '700' },
  challengeCopy: { flex: 1, minWidth: 0, gap: 3 },
  challengeTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  requiredBadge: { color: Accent, backgroundColor: AlarmPalette.peach, overflow: 'hidden', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 2, fontSize: 7, fontWeight: '800' },
  editText: { color: Accent, fontSize: 11, fontWeight: '600' },
  difficultyChip: { flex: 1, minHeight: 34, borderRadius: Radius.chip, alignItems: 'center', justifyContent: 'center' },
  statusCard: { minHeight: 56, borderWidth: 1, borderRadius: Radius.block, paddingHorizontal: Spacing.three, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bottomAction: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, paddingTop: Spacing.two, paddingHorizontal: Spacing.three, backgroundColor: AlarmPalette.cream },
  bottomCancel: { width: 44, height: 40, borderRadius: Radius.chip, backgroundColor: AlarmPalette.white, alignItems: 'center', justifyContent: 'center' },
  sectionTitle: {
    fontSize: 17,
    lineHeight: 24,
    marginTop: Spacing.four,
    marginBottom: Spacing.two,
  },
  titleInput: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: Radius.control,
    paddingHorizontal: Spacing.three,
    fontSize: 16,
    color: AlarmPalette.darkBrown,
    backgroundColor: AlarmPalette.white,
    borderColor: AlarmPalette.border,
  },
  bigTime: {
    fontSize: 56,
    lineHeight: 60,
    fontWeight: '700',
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
    marginBottom: Spacing.two,
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.one,
    gap: Spacing.three,
  },
  stepperLabel: {
    fontWeight: '600',
    flexShrink: 0,
  },
  stepperGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flexShrink: 0,
  },
  stepper: {
    width: 48,
    height: 48,
    borderRadius: Radius.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperValue: {
    fontSize: 24,
    lineHeight: 28,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    minWidth: 56,
    textAlign: 'center',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    marginTop: Spacing.two,
    marginBottom: Spacing.one,
  },
  chip: {
    borderRadius: Radius.chip,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    minWidth: 52,
    alignItems: 'center',
  },
  chipWide: {
    borderRadius: Radius.chip,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
    alignItems: 'center',
  },
  chipTextSelected: {
    color: '#ffffff',
    fontWeight: '700',
  },
  kindList: {
    gap: Spacing.two,
  },
  kindRow: {
    borderRadius: Radius.control,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    gap: Spacing.half,
  },
  fieldHint: {
    marginBottom: Spacing.one,
    lineHeight: 20,
  },
  summaryBox: {
    borderRadius: Radius.control,
    padding: Spacing.three,
    gap: Spacing.half,
    marginTop: Spacing.two,
  },
  nextNote: {
    lineHeight: 20,
    marginTop: Spacing.two,
  },
  summaryLine: {
    fontWeight: '600',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.two,
  },
  statusLabel: {
    fontWeight: '600',
  },
  errorText: {
    color: Danger,
    marginTop: Spacing.two,
  },
  saveButton: {
    backgroundColor: Accent,
    flex: 1,
    borderRadius: Radius.chip,
    minHeight: 52,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 0,
  },
  saveText: {
    color: '#ffffff',
    fontWeight: '700',
  },
  deleteButton: {
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.two,
  },
  deleteText: {
    color: Danger,
    fontWeight: '700',
  },
  cancelButton: {
    paddingVertical: Spacing.two,
    alignItems: 'center',
  },
  pressed: {
    opacity: 0.8,
  },
  disabled: {
    opacity: 0.5,
  },
});
