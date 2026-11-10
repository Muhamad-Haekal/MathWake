import type { SupabaseClient } from '@supabase/supabase-js';

import type { AlarmRow } from './home-data';

// ---------------------------------------------------------------------------
// Alarm CRUD data layer. Uses only columns verified against the live schema:
// id, user_id, time, days, title, is_active, is_recurring, difficulty,
// question_count, preset, created_at. Every statement is scoped to the
// authenticated user id. `preset` is never written (unknown vocabulary,
// possibly constrained). There is NO date column: one-time alarms mean
// "next occurrence" (today if the time is still ahead, else tomorrow).
// ---------------------------------------------------------------------------

export const ALARM_COLUMNS =
  'id,user_id,time,days,title,is_active,is_recurring,difficulty,question_count,preset,snooze_minutes,created_at';

const QUERY_LIMIT = 500;

export const DIFFICULTY_OPTIONS = ['mudah', 'sedang', 'sulit'] as const;
export type Difficulty = (typeof DIFFICULTY_OPTIONS)[number];

export const SNOOZE_INTERVALS = [5, 10, 15, 20, 30] as const;
export type SnoozeInterval = (typeof SNOOZE_INTERVALS)[number];
export const DEFAULT_SNOOZE_MINUTES: SnoozeInterval = 10;

export function isSnoozeInterval(value: unknown): value is SnoozeInterval {
  return typeof value === 'number' && SNOOZE_INTERVALS.some((minutes) => minutes === value);
}

/** Missing values from legacy rows/drafts use the database default. */
export function snoozeMinutesOrDefault(value: unknown): SnoozeInterval {
  return isSnoozeInterval(value) ? value : DEFAULT_SNOOZE_MINUTES;
}

/** Schedule kinds supported by the current schema (no migration needed). */
export type ScheduleKind = 'once' | 'daily' | 'custom';

export const WEEKDAY_PRESETS: { key: string; label: string; days: number[] }[] = [
  { key: 'daily', label: 'Setiap hari', days: [0, 1, 2, 3, 4, 5, 6] },
  { key: 'weekdays', label: 'Hari kerja', days: [1, 2, 3, 4, 5] },
  { key: 'weekend', label: 'Akhir pekan', days: [0, 6] },
];

/** Canonical day tokens written to `days` (round-trip via parseRepeatDays). */
const DAY_TOKEN_BY_NUMBER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface AlarmForm {
  /** Optional user-facing label, stored with a safe fallback. */
  title: string;
  /** "HH:MM" 24-hour. */
  time: string;
  /** Weekday numbers 0 = Sunday .. 6 = Saturday. */
  days: number[];
  /** False = one-time alarm (next occurrence only). */
  is_recurring: boolean;
  is_active: boolean;
  difficulty: string;
  question_count: number;
  snooze_minutes: SnoozeInterval;
}

/** Derives the schedule kind from stored fields (null = legacy recurring). */
export function scheduleKindOf(isRecurring: boolean | null, days: number[]): ScheduleKind {
  if (isRecurring === false) return 'once';
  if (days.length === 7) return 'daily';
  return 'custom';
}

export function dayNumbersToTokens(days: number[]): string[] {
  const unique = [...new Set(days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return unique.sort((a, b) => a - b).map((d) => DAY_TOKEN_BY_NUMBER[d]);
}

/** "HH:MM:SS" or "HH:MM" -> { h, m } or null. */
export function splitTimeParts(time: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?/.exec(time.trim());
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h > 23 || m > 59) return null;
  return { h, m };
}

/**
 * Adds deltaMinutes to an "HH:MM" time with day-wrap (mod 1440), so hour,
 * midnight, and date-boundary rollovers stay correct. Pure and unit-tested.
 */
export function shiftTime(time: string, deltaMinutes: number): string {
  const parts = splitTimeParts(time) ?? { h: 6, m: 0 };
  const total = ((parts.h * 60 + parts.m + deltaMinutes) % 1440 + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Current device time as "HH:MM". Call at press time, never cache it. */
export function nowTime(at: Date = new Date()): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** A fresh alarm draft uses the device's local time when the editor opens. */
export function createNewAlarmForm(at: Date = new Date()): AlarmForm {
  return {
    title: '',
    time: nowTime(at),
    days: [1, 2, 3, 4, 5],
    is_recurring: true,
    is_active: true,
    difficulty: 'sedang',
    question_count: 3,
    snooze_minutes: DEFAULT_SNOOZE_MINUTES,
  };
}

/**
 * Indonesian validation message, or null when the form is valid.
 * `now` is injectable so tests can pin the clock; callers default to the
 * device time. One-time alarms with a past time are rejected: without a
 * stored date column, "today at this time, already passed" can only mean
 * an expired event, never "tomorrow".
 */
export function validateAlarmForm(form: AlarmForm, now: Date = new Date()): string | null {
  if (typeof form.title === 'string' && form.title.length > 40) return 'Judul alarm maksimal 40 karakter.';
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(form.time)) {
    return 'Jam tidak valid. Gunakan format 24 jam, misalnya 05:30.';
  }
  if (form.is_recurring && form.days.length === 0) {
    return 'Pilih minimal satu hari untuk alarm berulang.';
  }
  if (!form.is_recurring && isOncePast(form.time, now)) {
    return 'Waktu hari ini sudah lewat. Pilih waktu yang akan datang untuk alarm sekali saja.';
  }
  if (!Number.isInteger(form.question_count) || form.question_count < 1 || form.question_count > 10) {
    return 'Jumlah soal harus antara 1 sampai 10.';
  }
  if (!isSnoozeInterval(form.snooze_minutes)) return 'Pilih interval Snooze yang tersedia.';
  if (!DIFFICULTY_OPTIONS.includes(form.difficulty as Difficulty)) {
    return 'Pilih level yang tersedia.';
  }
  return null;
}

/** True when a one-time "HH:MM" time already passed relative to `now`. */
export function isOncePast(time: string, now: Date): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return false;
  const candidate = new Date(now);
  candidate.setHours(parseInt(match[1], 10), parseInt(match[2], 10), 0, 0);
  return candidate.getTime() <= now.getTime();
}

export type OnceDecision = 'preserve' | 'fresh' | 'expired';

/**
 * Pure one-time scheduling decision, unit-tested:
 * - occurrence null (time passed) -> 'expired', never reschedule.
 * - recorded target equals the computed occurrence -> 'preserve' (no churn).
 * - otherwise -> 'fresh' (schedule a new DATE trigger for the occurrence).
 */
export function decideOnceSchedule(
  targetISO: string | null,
  occurrenceMs: number | null,
): OnceDecision {
  if (occurrenceMs === null) return 'expired';
  if (targetISO && Date.parse(targetISO) === occurrenceMs) return 'preserve';
  return 'fresh';
}

function throwIfError(error: { message: string } | null, op: string): void {
  if (error) {
    throw new Error(`Alarm ${op} gagal: ${error.message}`);
  }
}

export async function listAlarms(client: SupabaseClient, userId: string): Promise<AlarmRow[]> {
  const { data, error } = await client
    .from('alarms')
    .select(ALARM_COLUMNS)
    .eq('user_id', userId)
    .order('time', { ascending: true })
    .limit(QUERY_LIMIT);
  throwIfError(error, 'tidak dapat dimuat');
  return (data ?? []) as AlarmRow[];
}

export async function createAlarm(
  client: SupabaseClient,
  userId: string,
  form: AlarmForm,
): Promise<AlarmRow> {
  const validation = validateAlarmForm(form);
  if (validation) throw new Error(validation);
  const { data, error } = await client
    .from('alarms')
    .insert({
      user_id: userId,
      title: normalizeAlarmTitle(form.title),
      time: `${form.time}:00`,
      days: form.is_recurring ? dayNumbersToTokens(form.days) : [],
      is_active: form.is_active,
      is_recurring: form.is_recurring,
      difficulty: form.difficulty,
      question_count: form.question_count,
      snooze_minutes: form.snooze_minutes,
    })
    .select(ALARM_COLUMNS)
    .single();
  throwIfError(error, 'tidak dapat disimpan');
  return data as AlarmRow;
}

export async function updateAlarm(
  client: SupabaseClient,
  userId: string,
  alarmId: string,
  form: AlarmForm,
): Promise<AlarmRow> {
  const validation = validateAlarmForm(form);
  if (validation) throw new Error(validation);
  const { data, error } = await client
    .from('alarms')
    .update({
      title: normalizeAlarmTitle(form.title),
      time: `${form.time}:00`,
      days: form.is_recurring ? dayNumbersToTokens(form.days) : [],
      is_active: form.is_active,
      is_recurring: form.is_recurring,
      difficulty: form.difficulty,
      question_count: form.question_count,
      snooze_minutes: form.snooze_minutes,
    })
    .eq('id', alarmId)
    .eq('user_id', userId)
    .select(ALARM_COLUMNS)
    .single();
  throwIfError(error, 'tidak dapat diubah');
  return data as AlarmRow;
}

export function normalizeAlarmTitle(title: string | null | undefined): string {
  const normalized = typeof title === 'string' ? title.trim().slice(0, 40) : '';
  return normalized || 'Alarm';
}

export async function setAlarmActive(
  client: SupabaseClient,
  userId: string,
  alarmId: string,
  isActive: boolean,
): Promise<void> {
  const { error } = await client
    .from('alarms')
    .update({ is_active: isActive })
    .eq('id', alarmId)
    .eq('user_id', userId);
  throwIfError(error, isActive ? 'tidak dapat dinyalakan' : 'tidak dapat dimatikan');
}

export async function deleteAlarm(
  client: SupabaseClient,
  userId: string,
  alarmId: string,
): Promise<void> {
  const { error } = await client
    .from('alarms')
    .delete()
    .eq('id', alarmId)
    .eq('user_id', userId);
  throwIfError(error, 'tidak dapat dihapus');
}

/** Network failures get an Indonesian message; anything else stays generic. */
export function friendlyAlarmError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^Jam tidak valid|^Jumlah soal|^Pilih level/.test(message)) return message;
  const m = message.toLowerCase();
  if (
    m.includes('network') ||
    m.includes('fetch') ||
    m.includes('failed to fetch') ||
    m.includes('timeout') ||
    m.includes('abort')
  ) {
    return 'Tidak dapat terhubung. Periksa koneksi internet kamu.';
  }
  return 'Operasi alarm gagal. Coba lagi nanti.';
}
