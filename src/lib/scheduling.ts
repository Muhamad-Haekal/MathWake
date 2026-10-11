import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants, { AppOwnership } from 'expo-constants';
import { Platform } from 'react-native';
import type {
  NotificationContentInput,
  SchedulableNotificationTriggerInput,
} from 'expo-notifications';

import { nextOnceOccurrence, parseRepeatDays, type AlarmRow } from './home-data';
import { decideOnceSchedule, splitTimeParts } from './alarms';

// ---------------------------------------------------------------------------
// Local notification scheduling for alarms (expo-notifications, SDK 57).
//
// Expo Go safety: the native notification modules were removed from Expo Go
// on Android (SDK 53+), and merely evaluating `expo-notifications` throws at
// import time (requireNativeModule in the .native.js chain). So this module
// NEVER statically imports it. Instead it lazy-loads via dynamic import()
// behind a capability check: web and runtimes where the import fails report
// 'unsupported' / 'unavailable', and CRUD keeps working there. The full
// native implementation below runs unchanged in a development build.
// ---------------------------------------------------------------------------

const CHANNEL_ID = 'mathwake-alarms';
const SCHEDULE_MAP_KEY = 'mathwake:scheduled-notifications';

type NotificationsModule = typeof import('expo-notifications');

let cachedModule: NotificationsModule | null | undefined;
let handlerInstalled = false;

/**
 * Expo Go detector. expo-constants is a core module present in Expo Go,
 * so reading appOwnership is safe on every path. The package itself uses
 * the same signal (isRunningInExpoGo) for its own guards.
 */
function isExpoGo(): boolean {
  try {
    return Constants.appOwnership === AppOwnership.Expo;
  } catch {
    return false;
  }
}

/**
 * Capability-gated lazy loader. Returns null on web and in Expo Go, and
 * on runtimes where the import fails. Never throws.
 *
 * The Expo Go check runs BEFORE any import attempt: evaluating the
 * expo-notifications entry point in Expo Go Android throws during module
 * evaluation (push auto-registration side effects), and a try/catch
 * around the import cannot undo that evaluation. Gating first is what
 * keeps the unsupported path side-effect free.
 */
async function loadNotifications(): Promise<NotificationsModule | null> {
  if (cachedModule !== undefined) return cachedModule;
  if (Platform.OS === 'web' || isExpoGo()) {
    cachedModule = null;
    return cachedModule;
  }
  try {
    const mod = await import('expo-notifications');
    if (!handlerInstalled) {
      mod.setNotificationHandler({
        handleNotification: async () => ({
          shouldPlaySound: true,
          shouldSetBadge: false,
          shouldShowBanner: true,
          shouldShowList: true,
        }),
      });
      handlerInstalled = true;
    }
    cachedModule = mod;
  } catch (e) {
    console.warn('[MathWake][Schedule] native notifications unavailable:', {
      message: e instanceof Error ? e.message : 'unknown',
    });
    cachedModule = null;
  }
  return cachedModule;
}

export type SchedulePermission = 'granted' | 'denied' | 'undetermined' | 'unsupported' | 'unavailable';

export async function getSchedulePermission(): Promise<SchedulePermission> {
  if (Platform.OS === 'web') return 'unsupported';
  const N = await loadNotifications();
  if (!N) return 'unavailable';
  try {
    const { status } = await N.getPermissionsAsync();
    if (status === 'granted') return 'granted';
    if (status === 'denied') return 'denied';
    return 'undetermined';
  } catch {
    return 'undetermined';
  }
}

/** Requests permission (Android channel first) and reports the outcome. */
export async function ensureSchedulePermission(): Promise<SchedulePermission> {
  if (Platform.OS === 'web') return 'unsupported';
  const N = await loadNotifications();
  if (!N) return 'unavailable';
  try {
    if (Platform.OS === 'android') {
      await N.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Alarm MathWake',
        importance: N.AndroidImportance.MAX,
        vibrationPattern: [0, 500, 250, 500],
      });
    }
    const current = await N.getPermissionsAsync();
    if (current.status === 'granted') return 'granted';
    const requested = await N.requestPermissionsAsync();
    return requested.status === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/** Internal weekday 0 = Sunday .. 6 = Saturday -> expo weekday 1..7, Sunday-first. */
function toExpoWeekday(day: number): number {
  return (day % 7) + 1;
}

interface ScheduleEntry {
  ids: string[];
  /** ISO datetime of the one-time occurrence, or null for repeating alarms. */
  target: string | null;
}

function normalizeEntry(value: unknown): ScheduleEntry | null {
  if (Array.isArray(value)) {
    // Legacy shape from before targets were tracked.
    const ids = value.filter((v): v is string => typeof v === 'string');
    return { ids, target: null };
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as { ids?: unknown; target?: unknown };
    if (!Array.isArray(obj.ids)) return null;
    const ids = obj.ids.filter((v): v is string => typeof v === 'string');
    const target = typeof obj.target === 'string' ? obj.target : null;
    return { ids, target };
  }
  return null;
}

async function readScheduleMap(): Promise<Record<string, ScheduleEntry>> {
  try {
    const raw = await AsyncStorage.getItem(SCHEDULE_MAP_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, ScheduleEntry> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = normalizeEntry(value);
      if (entry) out[key] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

async function writeScheduleMap(map: Record<string, ScheduleEntry>): Promise<void> {
  try {
    await AsyncStorage.setItem(SCHEDULE_MAP_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn('[MathWake][Schedule] failed to persist schedule map');
  }
}

/**
 * Drops one alarm's schedule record without touching anything else.
 * Call after create/update/toggle-on so a stale one-time target can never
 * deactivate a freshly edited alarm. Map-only, safe on every runtime.
 */
export async function forgetScheduleTarget(alarmId: string): Promise<void> {
  try {
    const map = await readScheduleMap();
    if (map[alarmId]) {
      delete map[alarmId];
      await writeScheduleMap(map);
    }
  } catch (e) {
    console.warn('[MathWake][Schedule] failed to forget schedule target');
  }
}

async function cancelIds(
  N: NotificationsModule,
  ids: string[],
): Promise<void> {
  await Promise.all(
    ids.map((id) =>
      N.cancelScheduledNotificationAsync(id).catch(() => undefined),
    ),
  );
}

function alarmContent(alarm: AlarmRow): NotificationContentInput {
  return {
    title: 'MathWake',
    body: 'Saatnya bangun. Buka aplikasi untuk mematikan alarm.',
    data: { alarmId: alarm.id },
  };
}

export interface ScheduleOutcome {
  ids: string[];
  /** ISO datetime of the one-time occurrence, or null for repeating alarms. */
  target: string | null;
}

/**
 * Schedules local notifications for one active alarm.
 * Returns the scheduled identifiers plus the one-time target when set.
 *
 * Mapping per alarm:
 * - one-time (is_recurring === false) -> one DATE trigger at the next
 *   occurrence, regardless of leftover day tokens.
 * - repeating on specific weekdays -> one WEEKLY trigger per weekday
 *   (expo weekday 1..7, Sunday-first).
 * - repeating daily (unrecognized/empty day set) -> one DAILY trigger.
 */
export async function scheduleForAlarm(alarm: AlarmRow): Promise<ScheduleOutcome> {
  const empty: ScheduleOutcome = { ids: [], target: null };
  if (!alarm.is_active) return empty;
  const N = await loadNotifications();
  if (!N) return empty;
  const parts = splitTimeParts(alarm.time);
  if (!parts) return empty;

  const repeat = parseRepeatDays(alarm.days);
  const content = alarmContent(alarm);
  const ids: string[] = [];
  const TriggerTypes = N.SchedulableTriggerInputTypes;

  async function schedule(mod: NotificationsModule, trigger: SchedulableNotificationTriggerInput): Promise<void> {
    ids.push(await mod.scheduleNotificationAsync({ content, trigger }));
  }

  try {
    if (alarm.is_recurring === false || repeat === null) {
      // One-time: single DATE trigger at today's occurrence, or nothing
      // when that moment already passed. Never tomorrow.
      const at = nextOnceOccurrence(alarm, new Date());
      if (!at) return empty;
      await schedule(N, { type: TriggerTypes.DATE, date: at });
      return { ids, target: at.toISOString() };
    }
    if (repeat.size === 0) {
      await schedule(N, {
        type: TriggerTypes.DAILY,
        hour: parts.h,
        minute: parts.m,
        channelId: Platform.OS === 'android' ? CHANNEL_ID : undefined,
      });
      return { ids, target: null };
    }
    for (const day of repeat) {
      await schedule(N, {
        type: TriggerTypes.WEEKLY,
        weekday: toExpoWeekday(day),
        hour: parts.h,
        minute: parts.m,
        channelId: Platform.OS === 'android' ? CHANNEL_ID : undefined,
      });
    }
    return { ids, target: null };
  } catch (e) {
    console.warn('[MathWake][Schedule] schedule failed:', {
      alarmId: alarm.id,
      message: e instanceof Error ? e.message : 'unknown',
    });
    if (N) await cancelIds(N, ids);
    return empty;
  }
}

export interface ResyncResult {
  /** Alarms that ended up with at least one scheduled notification. */
  scheduledCount: number;
  /** Active alarms that could not be scheduled (permission or platform). */
  unscheduledActive: number;
  /**
   * Active one-time alarms whose recorded occurrence already passed.
   * The caller should deactivate these rows so reopening the app never
   * re-arms a finished one-time alarm.
   */
  expiredOnceIds: string[];
}

/**
 * Rebuilds all local schedules from the given alarms. One-time alarms with
 * a recorded occurrence in the past are reported as expired (never
 * rescheduled); repeating alarms are rebuilt as before. Only identifiers
 * recorded in our own map are ever cancelled. Never throws; failures are
 * counted so the UI stays truthful.
 */
export async function resyncSchedules(alarms: AlarmRow[]): Promise<ResyncResult> {
  const result: ResyncResult = { scheduledCount: 0, unscheduledActive: 0, expiredOnceIds: [] };
  const active = alarms.filter((a) => a.is_active);
  const N = await loadNotifications();
  if (!N) {
    // Web or Expo Go: nothing can be scheduled. Report honestly.
    result.unscheduledActive = active.length;
    return result;
  }
  const nowMs = Date.now();
  const previous = await readScheduleMap();
  const next: Record<string, ScheduleEntry> = {};

  // One-time alarms: the decision is purely computational. A past
  // occurrence means expired (never reschedule); a matching recorded
  // target means preserve (no churn); otherwise schedule fresh.
  const handled = new Set<string>();
  for (const alarm of active) {
    if (alarm.is_recurring !== false) continue;
    handled.add(alarm.id);
    const occurrence = nextOnceOccurrence(alarm, new Date(nowMs));
    const decision = decideOnceSchedule(
      previous[alarm.id]?.target ?? null,
      occurrence ? occurrence.getTime() : null,
    );
    if (decision === 'expired') {
      result.expiredOnceIds.push(alarm.id);
    } else if (decision === 'preserve' && previous[alarm.id]) {
      next[alarm.id] = previous[alarm.id];
      result.scheduledCount += 1;
    }
    // 'fresh': schedule below.
  }

  const toCancel = Object.entries(previous)
    .filter(([id]) => !handled.has(id) || result.expiredOnceIds.includes(id))
    .flatMap(([, entry]) => entry.ids);
  await cancelIds(N, toCancel);

  for (const alarm of active) {
    if (handled.has(alarm.id) && (next[alarm.id] || result.expiredOnceIds.includes(alarm.id))) {
      continue;
    }
    const outcome = await scheduleForAlarm(alarm);
    if (outcome.ids.length > 0) {
      next[alarm.id] = { ids: outcome.ids, target: outcome.target };
      result.scheduledCount += 1;
    } else {
      result.unscheduledActive += 1;
    }
  }
  await writeScheduleMap(next);
  return result;
}

/** Cancels one alarm's schedules and drops it from the map. */
export async function unscheduleAlarm(alarmId: string): Promise<void> {
  const map = await readScheduleMap();
  const ids = map[alarmId]?.ids ?? [];
  delete map[alarmId];
  await writeScheduleMap(map);
  const N = await loadNotifications();
  if (N) await cancelIds(N, ids);
}

let ringListenerInstalled = false;

export interface RingHandlerDeps {
  getUserId: () => Promise<string | null>;
  deactivateAlarm: (userId: string, alarmId: string) => Promise<void>;
  isOneTimeAlarm: (userId: string, alarmId: string) => Promise<boolean>;
}

/**
 * Deactivates one-time alarms after the user taps their notification, so a
 * fired one-time alarm never silently becomes active again. No-op on web
 * and in Expo Go (native module never loads there). Safe to call on every
 * mount: the listener is installed at most once. Only taps are observed;
 * a dismissed-without-tap notification leaves the alarm active, which the
 * Alarm list shows truthfully.
 */
export async function initOnceAlarmDeactivation(deps: RingHandlerDeps): Promise<void> {
  if (ringListenerInstalled) return;
  const N = await loadNotifications();
  if (!N) return;
  ringListenerInstalled = true;
  N.addNotificationResponseReceivedListener(async (response) => {
    try {
      const data = response.notification.request.content.data as
        | { alarmId?: unknown }
        | null
        | undefined;
      const alarmId = typeof data?.alarmId === 'string' ? data.alarmId : null;
      if (!alarmId) return;
      const userId = await deps.getUserId();
      if (!userId) return;
      if (!(await deps.isOneTimeAlarm(userId, alarmId))) return;
      await unscheduleAlarm(alarmId);
      await deps.deactivateAlarm(userId, alarmId);
    } catch (e) {
      console.warn('[MathWake][Schedule] once-alarm deactivation failed:', {
        message: e instanceof Error ? e.message : 'unknown',
      });
    }
  });
}
