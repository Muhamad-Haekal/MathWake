import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SectionHeader } from '@/components/home/section-header';
import { ThemedText } from '@/components/themed-text';
import { Accent, Danger, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/auth-context';
import { useTheme } from '@/hooks/use-theme';
import {
  DIFFICULTY_OPTIONS,
  WEEKDAY_PRESETS,
  dayNumbersToTokens,
  listRoutineSummary,
  nowTime,
  scheduleKindOf,
  shiftTime,
  splitTimeParts,
  validateAlarmForm,
  type AlarmForm,
  type RoutineSummaryItem,
  type ScheduleKind,
} from '@/lib/alarms';
import type { AlarmRow } from '@/lib/home-data';
import {
  describeAlarmDay,
  describeAlarmSchedule,
  formatTimeID,
  nextOccurrenceForAlarm,
  nextOnceOccurrence,
  parseRepeatDays,
} from '@/lib/home-data';
import { supabase } from '@/lib/supabase';

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

const KIND_OPTIONS: { key: ScheduleKind; title: string; hint: string }[] = [
  { key: 'once', title: 'Sekali saja', hint: 'Berbunyi sekali, lalu nonaktif' },
  { key: 'daily', title: 'Setiap hari', hint: 'Berbunyi tiap hari' },
  { key: 'custom', title: 'Hari tertentu', hint: 'Pilih hari satu per satu' },
];

const QUICK_ADDS: { label: string; minutes: number }[] = [
  { label: '+10 mnt', minutes: 10 },
  { label: '+30 mnt', minutes: 30 },
  { label: '+1 jam', minutes: 60 },
];

interface AlarmEditorModalProps {
  visible: boolean;
  /** Null when creating a new alarm. */
  alarm: AlarmRow | null;
  saving: boolean;
  onClose: () => void;
  onSave: (form: AlarmForm) => Promise<boolean>;
  onDelete: (alarm: AlarmRow) => void;
}

function formFromAlarm(alarm: AlarmRow | null): AlarmForm {
  if (!alarm) {
    return {
      time: '06:00',
      days: [1, 2, 3, 4, 5],
      is_recurring: true,
      is_active: true,
      difficulty: 'sedang',
      question_count: 3,
    };
  }
  const parts = splitTimeParts(alarm.time);
  const repeat = parseRepeatDays(alarm.days);
  const isRecurring = alarm.is_recurring !== false;
  return {
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
  };
}

/** Create/edit sheet. All controls are pure React Native (Expo Go safe). */
export function AlarmEditorModal({ visible, alarm, saving, onClose, onSave, onDelete }: AlarmEditorModalProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [form, setForm] = useState<AlarmForm>(() => formFromAlarm(alarm));
  const [kind, setKind] = useState<ScheduleKind>(() =>
    scheduleKindOf(formFromAlarm(alarm).is_recurring, formFromAlarm(alarm).days),
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [routine, setRoutine] = useState<RoutineSummaryItem[] | null>(null);
  const [routineError, setRoutineError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      const fresh = formFromAlarm(alarm);
      setForm(fresh);
      setKind(scheduleKindOf(fresh.is_recurring, fresh.days));
      setLocalError(null);
      setRoutine(null);
      setRoutineError(null);
    }
  }, [visible, alarm]);

  useEffect(() => {
    if (!visible || !user) return;
    let cancelled = false;
    setRoutine(null);
    setRoutineError(null);
    listRoutineSummary(supabase, user.id).then(
      (items) => {
        if (!cancelled) setRoutine(items);
      },
      () => {
        if (!cancelled) {
          setRoutine([]);
          setRoutineError('Rutinitas tidak dapat dimuat. Periksa koneksi lalu buka ulang form.');
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [visible, user]);

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
    const ok = await onSave(form);
    if (ok) onClose();
  }

  // Next-occurrence preview, split by kind: one-time alarms use the
  // single-occurrence logic (null when past), recurring alarms use the
  // repeating search. Never rolls a one-time alarm to tomorrow.
  const previewNow = new Date();
  const preview =
    kind === 'once'
      ? nextOnceOccurrence({ time: `${form.time}:00` }, previewNow)
      : nextOccurrenceForAlarm(
          { time: `${form.time}:00`, days: dayNumbersToTokens(form.days) } as AlarmRow,
          previewNow,
        );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropPress} onPress={onClose} accessibilityLabel="Tutup" />
        <View style={[styles.sheet, { backgroundColor: theme.background, paddingBottom: insets.bottom + Spacing.four }]}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <SectionHeader title={alarm ? 'Ubah alarm' : 'Alarm baru'} />

            {/* 1. Waktu alarm */}
            <ThemedText type="smallBold" style={styles.sectionTitle}>Waktu alarm</ThemedText>
            <ThemedText style={styles.bigTime} accessibilityLabel={`Waktu ${form.time}`}>
              {hourStr}.{minuteStr}
            </ThemedText>
            <TimeStepperRow
              label="Jam"
              value={hourStr}
              saving={saving}
              onMinus={() => setForm((f) => ({ ...f, time: shiftTime(f.time, -60) }))}
              onPlus={() => setForm((f) => ({ ...f, time: shiftTime(f.time, 60) }))}
            />
            <TimeStepperRow
              label="Menit"
              value={minuteStr}
              saving={saving}
              onMinus={() => setForm((f) => ({ ...f, time: shiftTime(f.time, -1) }))}
              onPlus={() => setForm((f) => ({ ...f, time: shiftTime(f.time, 1) }))}
            />
            <View style={styles.chipRow}>
              {QUICK_ADDS.map(({ label, minutes }) => (
                <Pressable
                  key={label}
                  disabled={saving}
                  onPress={() => setForm((f) => ({ ...f, time: shiftTime(nowTime(), minutes) }))}
                  accessibilityRole="button"
                  accessibilityLabel={`Atur ${label} dari sekarang`}
                  style={[styles.chip, { backgroundColor: theme.backgroundElement }]}>
                  <ThemedText type="small" style={{ color: theme.textSecondary }}>{label}</ThemedText>
                </Pressable>
              ))}
            </View>
            <ThemedText type="small" themeColor="textSecondary">
              Tombol cepat dihitung dari jam perangkat saat ini. Nilai lama tetap sampai kamu menekan Simpan.
            </ThemedText>

            {/* 2. Jadwal */}
            <ThemedText type="smallBold" style={styles.sectionTitle}>Jadwal</ThemedText>
            <View style={styles.kindList}>
              {KIND_OPTIONS.map(({ key, title, hint }) => {
                const selected = kind === key;
                return (
                  <Pressable
                    key={key}
                    disabled={saving}
                    onPress={() => setKindOption(key)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={title}
                    style={[
                      styles.kindRow,
                      {
                        backgroundColor: selected ? Accent : theme.backgroundElement,
                      },
                    ]}>
                    <ThemedText
                      type="smallBold"
                      style={selected ? styles.chipTextSelected : { color: theme.text }}>
                      {title}
                    </ThemedText>
                    <ThemedText
                      type="small"
                      style={selected ? styles.chipTextSelected : { color: theme.textSecondary }}>
                      {hint}
                    </ThemedText>
                  </Pressable>
                );
              })}
            </View>

            {kind === 'custom' ? (
              <View>
                <View style={styles.chipRow}>
                  {WEEKDAY_PRESETS.map(({ key, label, days }) => (
                    <Pressable
                      key={key}
                      disabled={saving}
                      onPress={() => applyPreset(days)}
                      accessibilityRole="button"
                      accessibilityLabel={label}
                      style={[styles.chipWide, { backgroundColor: theme.backgroundElement }]}>
                      <ThemedText type="small" style={{ color: theme.textSecondary }}>{label}</ThemedText>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.chipRow}>
                  {DAY_BUTTONS.map(({ value, label }) => {
                    const selected = form.days.includes(value);
                    return (
                      <Pressable
                        key={value}
                        disabled={saving}
                        onPress={() => toggleDay(value)}
                        accessibilityRole="button"
                        accessibilityLabel={`${label}${selected ? ', dipilih' : ''}`}
                        accessibilityState={{ selected }}
                        style={[
                          styles.chip,
                          { backgroundColor: selected ? Accent : theme.backgroundElement },
                        ]}>
                        <ThemedText
                          type="small"
                          style={selected ? styles.chipTextSelected : { color: theme.textSecondary }}>
                          {label}
                        </ThemedText>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}

            {/* Small neutral next-time note, not a selectable card. */}
            {kind === 'once' ? (
              preview ? (
                <ThemedText type="small" themeColor="textSecondary" style={styles.nextNote}>
                  Jadwal sekali saja • {describeAlarmDay(preview, previewNow)}, {formatTimeID(form.time)}
                </ThemedText>
              ) : (
                <ThemedText type="small" style={[styles.nextNote, { color: Danger }]}>
                  Waktu alarm sudah lewat. Pilih waktu baru untuk melanjutkan.
                </ThemedText>
              )
            ) : preview ? (
              <ThemedText type="small" themeColor="textSecondary" style={styles.nextNote}>
                Berikutnya: {describeAlarmDay(preview, previewNow)}, {formatTimeID(form.time)}
              </ThemedText>
            ) : null}

            {/* 3. Tantangan matematika */}
            <ThemedText type="smallBold" style={styles.sectionTitle}>Tantangan matematika</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.fieldHint}>
              Level dan jumlah soal tersimpan untuk alarm ini.
            </ThemedText>
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

            {/* 4. Rutinitas pagi */}
            <ThemedText type="smallBold" style={styles.sectionTitle}>Rutinitas pagi</ThemedText>
            {routine === null && !routineError ? (
              <View style={styles.routineBox}>
                <View style={[styles.skeletonLine, { backgroundColor: theme.backgroundElement }]} />
                <View style={[styles.skeletonLine, { backgroundColor: theme.backgroundElement }]} />
              </View>
            ) : routineError ? (
              <View style={styles.routineBox}>
                <ThemedText type="small" themeColor="textSecondary">{routineError}</ThemedText>
              </View>
            ) : routine && routine.length === 0 ? (
              <View style={styles.routineBox}>
                <ThemedText type="small" themeColor="textSecondary">
                  Belum ada rutinitas pagi.
                </ThemedText>
              </View>
            ) : (
              <View style={styles.routineBox}>
                {routine?.map((item, index) => (
                  <View key={item.id} style={styles.routineRow}>
                    <ThemedText type="small" themeColor="textSecondary">{index + 1}.</ThemedText>
                    <ThemedText type="small" style={styles.routineLabel}>{item.label}</ThemedText>
                  </View>
                ))}
                <ThemedText type="small" themeColor="textSecondary" style={styles.routineNote}>
                  Rutinitas berlaku setiap pagi. Penetapan per alarm belum didukung backend.
                </ThemedText>
              </View>
            )}

            {/* 5. Status dan ringkasan */}
            <ThemedText type="smallBold" style={styles.sectionTitle}>Status</ThemedText>
            <View style={styles.statusRow}>
              <ThemedText type="small" style={styles.statusLabel}>
                {form.is_active ? 'Alarm aktif' : 'Alarm nonaktif'}
              </ThemedText>
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

            {/* 6. Simpan */}
            <Pressable
              disabled={saving}
              onPress={handleSave}
              accessibilityRole="button"
              accessibilityLabel="Simpan alarm"
              style={({ pressed }) => [
                styles.saveButton,
                pressed && styles.pressed,
                saving && styles.disabled,
              ]}>
              <ThemedText type="small" style={styles.saveText}>
                {saving ? 'Menyimpan...' : 'Simpan alarm'}
              </ThemedText>
            </Pressable>

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
        </View>
      </View>
    </Modal>
  );
}

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
  const theme = useTheme();
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

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  backdropPress: {
    flex: 1,
  },
  sheet: {
    borderTopLeftRadius: Radius.block,
    borderTopRightRadius: Radius.block,
    padding: Spacing.four,
    maxHeight: '92%',
  },
  sectionTitle: {
    fontSize: 17,
    lineHeight: 24,
    marginTop: Spacing.four,
    marginBottom: Spacing.two,
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
  routineBox: {
    gap: Spacing.two,
    paddingVertical: Spacing.one,
  },
  routineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  routineLabel: {
    fontWeight: '600',
    flex: 1,
    flexShrink: 1,
  },
  routineNote: {
    lineHeight: 20,
    marginTop: Spacing.one,
  },
  skeletonLine: {
    height: 40,
    borderRadius: Radius.control,
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
    borderRadius: Radius.control,
    paddingVertical: Spacing.three + Spacing.half,
    alignItems: 'center',
    marginTop: Spacing.four,
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
