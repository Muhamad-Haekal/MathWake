import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Home dashboard data layer.
//
// Schema below mirrors the tables verified against the live Supabase project
// (PostgREST probe, anon role): every column typed here returned 401
// (exists, RLS-protected) while invented names returned 42703.
// Unknown vocabularies (status / difficulty / days / preset values) are
// parsed defensively and never assumed.
// ---------------------------------------------------------------------------

export interface AlarmRow {
  id: string;
  user_id: string;
  /** Postgres `time` serialized as "HH:MM:SS". Interpreted in device local time. */
  time: string;
  /** Weekday tokens, e.g. ["Mon","Wed"] or ["1","3"]. Null/empty = non-repeating. */
  days: string[] | null;
  is_active: boolean;
  /** False = one-time alarm (next occurrence only). Null = legacy row, treat as recurring. */
  is_recurring: boolean | null;
  difficulty: string | null;
  question_count: number | null;
  preset: string | null;
  created_at: string;
}

export interface RoutineItemRow {
  id: string;
  user_id: string;
  label: string;
  sort_order: number;
  /** Target repetitions for the item. */
  count: number;
}

export interface RoutineCompletionRow {
  routine_item_id: string;
  completed_date: string;
  count: number;
}

export interface AlarmLogRow {
  id: string;
  alarm_id: string;
  completed_at: string;
  status: string | null;
}

export interface AttemptRow {
  is_correct: boolean | null;
  created_at: string;
}

export interface NextAlarm {
  alarm: AlarmRow;
  at: Date;
}

export interface RoutineProgress {
  item: RoutineItemRow;
  done: number;
  target: number;
  finished: boolean;
}

export interface HomeData {
  activeAlarms: AlarmRow[];
  nextAlarm: NextAlarm | null;
  routine: RoutineProgress[];
  routineDone: number;
  routineTotal: number;
  logsToday: number;
  attemptsToday: { total: number; correct: number };
  /**
   * True when the attempts query failed (e.g. missing GRANT) and
   * attemptsToday is therefore unknown, not zero. The UI must not
   * present it as "no activity".
   */
  attemptsUnavailable: boolean;
}

// ---------------------------------------------------------------------------
// Date helpers (device local time, Indonesian locale)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Local calendar date as "YYYY-MM-DD" for `date` column filters. */
export function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function formatFullDateID(d: Date): string {
  return new Intl.DateTimeFormat('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);
}

/** "05:30:00" (or "05:30") -> "05.30" (Indonesian time separator). */
export function formatTimeID(time: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(time.trim());
  if (!m) return time;
  return `${m[1].padStart(2, '0')}.${m[2]}`;
}

export function greetingForHour(hour: number): string {
  if (hour >= 4 && hour < 11) return 'Selamat pagi';
  if (hour >= 11 && hour < 15) return 'Selamat siang';
  if (hour >= 15 && hour < 19) return 'Selamat sore';
  return 'Selamat malam';
}

// ---------------------------------------------------------------------------
// Weekday parsing. Tokens observed in the wild may be English short names,
// Indonesian names, or numbers. Unknown tokens are dropped; when a
// non-empty array yields no recognizable day we fall back to daily, which
// is documented in the final report as an assumption.
// ---------------------------------------------------------------------------

const DAY_NAMES_ID = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const DAY_NAMES_FULL_ID = [
  'Minggu',
  'Senin',
  'Selasa',
  'Rabu',
  'Kamis',
  'Jumat',
  'Sabtu',
];

const TOKEN_TO_DAY: Record<string, number> = {
  sun: 0,
  minggu: 0,
  min: 0,
  monday: 1,
  mon: 1,
  senin: 1,
  sen: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  selasa: 2,
  sel: 2,
  wednesday: 3,
  wed: 3,
  rabu: 3,
  rab: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  kamis: 4,
  kam: 4,
  friday: 5,
  fri: 5,
  jumat: 5,
  'jum’at': 5,
  jum: 5,
  saturday: 6,
  sat: 6,
  sabtu: 6,
  sab: 6,
};

function parseNumericDay(token: string, hasZero: boolean): number | null {
  if (!/^\d+$/.test(token)) return null;
  const n = parseInt(token, 10);
  if (hasZero) {
    // 0 = Sunday .. 6 = Saturday
    return n >= 0 && n <= 6 ? n : null;
  }
  // 1 = Monday .. 7 = Sunday
  if (n >= 1 && n <= 7) return n % 7;
  return null;
}

/**
 * Returns null when the alarm does not repeat (null/empty array).
 * Returns a set of weekday numbers (0 = Sunday) otherwise.
 */
export function parseRepeatDays(days: unknown): Set<number> | null {
  if (!Array.isArray(days) || days.length === 0) return null;
  const raw = days.filter((d): d is string => typeof d === 'string');
  if (raw.length === 0) return null;
  const lowered = raw.map((d) => d.trim().toLowerCase());
  const hasZero = lowered.includes('0');
  const out = new Set<number>();
  for (const token of lowered) {
    const named = TOKEN_TO_DAY[token];
    if (named !== undefined) {
      out.add(named);
      continue;
    }
    const numeric = parseNumericDay(token, hasZero);
    if (numeric !== null) out.add(numeric);
  }
  return out;
}

function parseTimeToParts(time: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(time.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/**
 * Next ringing datetime for a REPEATING alarm after `now`.
 * Empty repeat set (all tokens unknown) is treated as daily.
 * Must NOT be used for one-time alarms (see nextOnceOccurrence).
 */
export function nextOccurrenceForAlarm(
  alarm: AlarmRow,
  now: Date,
): Date | null {
  const parts = parseTimeToParts(alarm.time);
  if (!parts) return null;
  const repeat = parseRepeatDays(alarm.days);
  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    candidate.setHours(parts.h, parts.m, 0, 0);
    if (offset === 0 && candidate.getTime() <= now.getTime()) continue;
    if (repeat === null || repeat.size === 0 || repeat.has(candidate.getDay())) {
      return candidate;
    }
  }
  return null;
}

export function nextAlarmFromList(alarms: AlarmRow[], now: Date): NextAlarm | null {
  let best: NextAlarm | null = null;
  for (const alarm of alarms) {
    if (!alarm.is_active) continue;
    // One-time alarms use their own single-occurrence logic: an expired
    // one-time alarm is skipped here, never rolled to tomorrow.
    const at =
      alarm.is_recurring === false
        ? nextOnceOccurrence({ time: alarm.time }, now)
        : nextOccurrenceForAlarm(alarm, now);
    if (!at) continue;
    if (!best || at.getTime() < best.at.getTime()) best = { alarm, at };
  }
  return best;
}

/**
 * True when a one-time "HH:MM[:SS]" time has already passed today.
 * Date-agnostic on purpose: without a stored alarm date, a one-time
 * alarm means "today at this time", and a past time means expired.
 */
export function isOnceExpired(time: string, now: Date): boolean {
  const parts = parseTimeToParts(time);
  if (!parts) return false;
  const candidate = new Date(now);
  candidate.setHours(parts.h, parts.m, 0, 0);
  return candidate.getTime() <= now.getTime();
}

/**
 * The single occurrence of a one-time alarm: today at the given time,
 * or null when that moment already passed. NEVER tomorrow: rolling a
 * one-time alarm forward is exactly the bug this guards against.
 */
export function nextOnceOccurrence(
  alarm: Pick<AlarmRow, 'time'>,
  now: Date,
): Date | null {
  const parts = parseTimeToParts(alarm.time);
  if (!parts) return null;
  const candidate = new Date(now);
  candidate.setHours(parts.h, parts.m, 0, 0);
  return candidate.getTime() > now.getTime() ? candidate : null;
}

/** "Senin, Rabu, Jumat", "Setiap hari", or "Sekali saja". No em-dash anywhere. */
export function describeRepeatDays(days: unknown): string {
  const repeat = parseRepeatDays(days);
  if (repeat === null) return 'Sekali saja';
  if (repeat.size === 0 || repeat.size === 7) return 'Setiap hari';
  return [...repeat]
    .sort((a, b) => a - b)
    .map((d) => DAY_NAMES_ID[d])
    .join(', ');
}

/**
 * Schedule summary honoring the is_recurring flag: false always means
 * "Sekali saja" even if legacy day tokens linger on the row.
 */
export function describeAlarmSchedule(alarm: Pick<AlarmRow, 'is_recurring' | 'days'>): string {
  if (alarm.is_recurring === false) return 'Sekali saja';
  return describeRepeatDays(alarm.days);
}

/** "Hari ini", "Besok", or the weekday name for a future datetime. */
export function describeAlarmDay(at: Date, now: Date): string {
  const startToday = startOfToday();
  const diffDays = Math.round((startOfDay(at).getTime() - startToday.getTime()) / DAY_MS);
  if (diffDays <= 0) return 'Hari ini';
  if (diffDays === 1) return 'Besok';
  return DAY_NAMES_FULL_ID[at.getDay()];
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

/** "dalam 5 menit", "dalam 2 jam 10 menit", "dalam 3 hari". */
export function formatCountdown(at: Date, now: Date): string {
  const diffMs = Math.max(0, at.getTime() - now.getTime());
  const totalMinutes = Math.floor(diffMs / 60000);
  if (totalMinutes < 1) return 'segera berbunyi';
  if (totalMinutes < 60) return `dalam ${totalMinutes} menit`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) {
    return minutes === 0 ? `dalam ${hours} jam` : `dalam ${hours} jam ${minutes} menit`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? 'dalam 1 hari' : `dalam ${days} hari`;
}

// ---------------------------------------------------------------------------
// Queries. Every query is scoped to the authenticated user id so a
// misconfigured RLS policy can never leak another user's rows.
// ---------------------------------------------------------------------------

const QUERY_LIMIT = 500;

function throwIfError(error: { message: string } | null, table: string): void {
  if (error) {
    throw new Error(`Query ${table} gagal: ${error.message}`);
  }
}

export async function fetchHomeData(
  client: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<HomeData> {
  const todayStr = toLocalDateString(now);
  const weekAgo = new Date(now.getTime() - 6 * DAY_MS);
  const weekAgoStr = toLocalDateString(weekAgo);
  const weekAgoISO = weekAgo.toISOString();

  const [alarmsRes, itemsRes, completionsRes, logsRes] = await Promise.all([
    client
      .from('alarms')
      .select('id,user_id,time,days,is_active,is_recurring,difficulty,question_count,preset,created_at')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('time', { ascending: true })
      .limit(QUERY_LIMIT),
    // NOTE: select="*" is deliberate here. The table has a data column
    // literally named `count`, and PostgREST parses a bare `count` in the
    // select list as the count() aggregate (verified live: 42803 GROUP BY
    // error), even when double-quoted. Star-select avoids the collision;
    // only the verified columns below are read from the rows.
    client
      .from('routine_items')
      .select('*')
      .eq('user_id', userId)
      .order('sort_order', { ascending: true })
      .limit(QUERY_LIMIT),
    // Same `count`-column collision as routine_items: star-select, then
    // join to items in TypeScript via routine_item_id below.
    client
      .from('routine_completions')
      .select('*')
      .eq('user_id', userId)
      .gte('completed_date', weekAgoStr)
      .limit(QUERY_LIMIT),
    client
      .from('alarm_logs')
      .select('id,alarm_id,completed_at,status')
      .eq('user_id', userId)
      .gte('completed_at', weekAgoISO)
      .order('completed_at', { ascending: false })
      .limit(QUERY_LIMIT),
  ]);

  throwIfError(alarmsRes.error, 'alarms');
  throwIfError(itemsRes.error, 'routine_items');
  throwIfError(completionsRes.error, 'routine_completions');
  throwIfError(logsRes.error, 'alarm_logs');

  // Attempts is read defensively: the authenticated role may lack SELECT
  // on this table (known missing GRANT, answer history is sensitive).
  // A denial degrades only the accuracy metric instead of failing the
  // whole dashboard, and is flagged so the UI stays truthful.
  let attempts: AttemptRow[] = [];
  let attemptsUnavailable = false;
  try {
    const attemptsRes = await client
      .from('attempts')
      .select('is_correct,created_at')
      .eq('user_id', userId)
      .gte('created_at', weekAgoISO)
      .order('created_at', { ascending: false })
      .limit(QUERY_LIMIT);
    if (attemptsRes.error) throw attemptsRes.error;
    attempts = (attemptsRes.data ?? []) as AttemptRow[];
  } catch (e) {
    attemptsUnavailable = true;
    console.warn('[MathWake][Home] attempts unavailable:', {
      message: e instanceof Error ? e.message : 'unknown',
    });
  }

  const activeAlarms = (alarmsRes.data ?? []) as AlarmRow[];
  const items = (itemsRes.data ?? []) as RoutineItemRow[];
  const completions = (completionsRes.data ?? []) as RoutineCompletionRow[];
  const logs = (logsRes.data ?? []) as AlarmLogRow[];

  const doneByItem = new Map<string, number>();
  for (const c of completions) {
    if (c.completed_date !== todayStr) continue;
    const prev = doneByItem.get(c.routine_item_id) ?? 0;
    const add = typeof c.count === 'number' && Number.isFinite(c.count) ? c.count : 1;
    doneByItem.set(c.routine_item_id, prev + add);
  }

  const routine: RoutineProgress[] = items.map((item) => {
    const target = typeof item.count === 'number' && item.count > 0 ? item.count : 1;
    const done = Math.min(doneByItem.get(item.id) ?? 0, target);
    return { item, done, target, finished: done >= target };
  });
  const routineDone = routine.filter((r) => r.finished).length;

  const isToday = (iso: string) => toLocalDateString(new Date(iso)) === todayStr;
  const logsToday = logs.filter((l) => isToday(l.completed_at)).length;

  const attemptsTodayRows = attempts.filter((a) => isToday(a.created_at));
  const attemptsToday = {
    total: attemptsTodayRows.length,
    correct: attemptsTodayRows.filter((a) => a.is_correct === true).length,
  };

  return {
    activeAlarms,
    nextAlarm: nextAlarmFromList(activeAlarms, now),
    routine,
    routineDone,
    routineTotal: routine.length,
    logsToday,
    attemptsToday,
    attemptsUnavailable,
  };
}

/** Network failures get an Indonesian message; anything else stays generic. */
export function friendlyFetchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
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
  return 'Gagal memuat data. Coba lagi nanti.';
}
