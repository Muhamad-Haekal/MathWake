import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants, { AppOwnership } from 'expo-constants';
import type {
    NotificationContentInput,
    SchedulableNotificationTriggerInput,
} from 'expo-notifications';
import { Platform } from 'react-native';

import { decideOnceSchedule, splitTimeParts } from './alarms';
import { startAlarmAudio } from './alarm-audio';
import {
  acknowledgeNativePendingAlarm,
  PENDING_RECENCY_MS,
  cancelNativeAlarm,
  consumeNativePendingAlarm,
  getNativeActiveAlarmId,
  hasNativeFutureAlarmSchedule,
  hasOtherNativeLiveOccurrence,
  scheduleNativeAlarm,
  updateNativeAlarmSnoozeMinutes,
} from './alarm-native';
import {
  nextOccurrenceForAlarm,
  nextOnceOccurrence,
  parseRepeatDays,
  type AlarmRow,
} from './home-data';

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
/**
 * Base filename of the bundled alarm sound. Must match the file registered
 * in app.json expo-notifications `sounds` (only the base name is used).
 */
const ALARM_SOUND_FILENAME = 'alarm.wav';

let scheduleMutationTail: Promise<void> = Promise.resolve();

async function withScheduleMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const predecessor = scheduleMutationTail;
  let release!: () => void;
  scheduleMutationTail = new Promise<void>((resolve) => { release = resolve; });
  await predecessor;
  try { return await operation(); } finally { release(); }
}

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
        // Custom alarm sound (base filename only; file registered via the
        // expo-notifications config plugin `sounds` in app.json).
        // Required on Android 8+: the channel — not the content — controls
        // sound for scheduled notifications.
        sound: ALARM_SOUND_FILENAME,
        // Route audio through the Android ALARM stream so the notification
        // respects the user's alarm volume (not media/notification volume).
        audioAttributes: {
          usage: N.AndroidAudioUsage.ALARM,
          contentType: N.AndroidAudioContentType.SONIFICATION,
          flags: { enforceAudibility: true, requestHardwareAudioVideoSynchronization: false },
        },
        // Keep the notification visible on the lock screen.
        lockscreenVisibility: N.AndroidNotificationVisibility.PUBLIC,
        // Show badge on launcher icon.
        showBadge: true,
        // Allow notification to bypass DND when set.
        bypassDnd: false,
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
  /**
   * Which engine armed this alarm. 'native' = AlarmManager exact alarm via
   * the MathWakeAlarm module (Android dev build); undefined/absent = legacy
   * expo-notifications identifiers. Determines how cancellation works.
   */
  engine?: 'native';
}

function normalizeEntry(value: unknown): ScheduleEntry | null {
  if (Array.isArray(value)) {
    // Legacy shape from before targets were tracked.
    const ids = value.filter((v): v is string => typeof v === 'string');
    return { ids, target: null };
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as { ids?: unknown; target?: unknown; engine?: unknown };
    if (!Array.isArray(obj.ids)) return null;
    const ids = obj.ids.filter((v): v is string => typeof v === 'string');
    const target = typeof obj.target === 'string' ? obj.target : null;
    const entry: ScheduleEntry = { ids, target };
    if (obj.engine === 'native') entry.engine = 'native';
    return entry;
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
  } catch {
    console.warn('[MathWake][Schedule] failed to persist schedule map');
  }
}

/**
 * Drops one alarm's schedule record without touching anything else.
 * Call after create/update/toggle-on so a stale one-time target can never
 * deactivate a freshly edited alarm. Map-only, safe on every runtime.
 *
 * Also best-effort cancels a native exact alarm for the id: the entry is
 * gone from the map after this, so a later resync could no longer find and
 * cancel the stale OS-side alarm (ghost alarm). No-op off Android dev builds.
 */
export async function forgetScheduleTarget(alarmId: string): Promise<void> {
  return withScheduleMutationLock(async () => {
  try {
    const map = await readScheduleMap();
    if (map[alarmId]) {
      delete map[alarmId];
      await writeScheduleMap(map);
    }
  } catch {
    console.warn('[MathWake][Schedule] failed to forget schedule target');
  }
  await cancelNativeAlarm(alarmId);
  });
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

function alarmContent(alarm: AlarmRow, N: NotificationsModule): NotificationContentInput {
  const alarmTitle = typeof alarm.title === 'string' ? alarm.title.trim().slice(0, 40) || 'Alarm' : 'Alarm';
  return {
    title: alarmTitle,
    body: 'Saatnya bangun. Ketuk untuk membuka tantangan matematika.',
    data: { alarmId: alarm.id },
    // Custom sound: used on Android < 8 and on iOS (base filename only).
    // On Android 8+ the channel sound above takes precedence.
    sound: ALARM_SOUND_FILENAME,
    // High priority so the alarm breaks through; sticky + no auto-dismiss
    // so the notification stays until the user acts on it.
    priority: N.AndroidNotificationPriority.MAX,
    sticky: true,
    autoDismiss: false,
    vibrate: [0, 500, 250, 500],
  };
}

export interface ScheduleOutcome {
  ids: string[];
  /** ISO datetime of the one-time occurrence, or null for repeating alarms. */
  target: string | null;
  /** 'native' when armed via AlarmManager; 'expo' for notification fallback. */
  engine: 'expo' | 'native';
}

/**
 * Schedules local notifications for one active alarm.
 * Returns the scheduled identifiers plus the one-time target when set.
 *
 * Engine order on Android dev builds: native exact alarm first
 * (AlarmManager.setAlarmClock + full-screen intent — rings and opens the
 * challenge without requiring a tap), expo-notifications as fallback
 * (Expo Go, web, iOS, or native unavailable/declined).
 *
 * Mapping per alarm:
 * - one-time (is_recurring === false) -> single occurrence today, never
 *   tomorrow, regardless of leftover day tokens.
 * - repeating on specific weekdays -> next weekly occurrence per weekday
 *   (expo weekday 1..7, Sunday-first); native takes the earliest single shot
 *   and re-arms the following one at fire time.
 * - repeating daily (unrecognized/empty day set) -> next daily occurrence.
 */
export async function scheduleForAlarm(alarm: AlarmRow): Promise<ScheduleOutcome> {
  const empty: ScheduleOutcome = { ids: [], target: null, engine: 'expo' };
  if (!alarm.is_active) return empty;
  const parts = splitTimeParts(alarm.time);
  if (!parts) return empty;

  const repeat = parseRepeatDays(alarm.days);
  const isOnce = alarm.is_recurring === false || repeat === null;
  const now = new Date();
  // Single source of truth for "when does this alarm fire next", shared by
  // both engines so one-time/repeating semantics stay identical.
  const when = isOnce
    ? nextOnceOccurrence(alarm, now)
    : nextOccurrenceForAlarm(alarm, now);
  if (!when) return empty;

  // Native exact alarm first (Android dev build only; no-op elsewhere).
  // Do not make AlarmManager depend on expo-notifications loading successfully:
  // the native ringer can still provide the alarm sound and sticky notification.
  // On success the expo path below is skipped entirely — a single engine
  // owns the alarm, so the user never gets double notifications.
  const native = await scheduleNativeAlarm(alarm, when);
  if (native.scheduled) {
    // Logcat triage line: proves on-device which engine owns the alarm.
    // Filter logcat with: adb logcat | grep MathWake
    console.info('[MathWake][Schedule] armed via native exact alarm:', {
      alarmId: alarm.id,
      at: when.toISOString(),
      exact: native.exact,
    });
    if (!native.exact) {
      console.warn('[MathWake][Schedule] native alarm fell back to inexact:', {
        alarmId: alarm.id,
      });
    }
    return { ids: [], target: when.toISOString(), engine: 'native' };
  }

  const N = await loadNotifications();
  if (!N) return empty;
  const content = alarmContent(alarm, N);
  const ids: string[] = [];
  const TriggerTypes = N.SchedulableTriggerInputTypes;
  const channelId = Platform.OS === 'android' ? CHANNEL_ID : undefined;

  async function schedule(mod: NotificationsModule, trigger: SchedulableNotificationTriggerInput): Promise<void> {
    ids.push(await mod.scheduleNotificationAsync({ content, trigger }));
  }

  try {
    if (isOnce) {
      // One-time: single DATE trigger at the precomputed occurrence.
      // `when` is null when that moment already passed — returned early
      // above. Never tomorrow.
      // One-time alarms MUST carry the alarm channel on Android 8+ —
      // without channelId the notification falls back to Miscellaneous
      // (default sound, lower importance) and the alarm is effectively silent.
      await schedule(N, { type: TriggerTypes.DATE, date: when, channelId });
      return { ids, target: when.toISOString(), engine: 'expo' };
    }
    if (repeat.size === 0) {
      await schedule(N, {
        type: TriggerTypes.DAILY,
        hour: parts.h,
        minute: parts.m,
        channelId,
      });
      return { ids, target: null, engine: 'expo' };
    }
    for (const day of repeat) {
      await schedule(N, {
        type: TriggerTypes.WEEKLY,
        weekday: toExpoWeekday(day),
        hour: parts.h,
        minute: parts.m,
        channelId,
      });
    }
    return { ids, target: null, engine: 'expo' };
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
async function resyncSchedulesUnlocked(alarms: AlarmRow[]): Promise<ResyncResult> {
  const result: ResyncResult = { scheduledCount: 0, unscheduledActive: 0, expiredOnceIds: [] };
  const active = alarms.filter((a) => a.is_active);
  const N = await loadNotifications();
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

  // Cancel every previously scheduled notification EXCEPT preserved
  // one-time entries. In particular a one-time alarm being rescheduled
  // ("fresh") must have its stale DATE notification cancelled — otherwise
  // the old time still fires as a ghost alarm alongside the new one.
  const preservedIds = new Set(Object.keys(next));
  for (const alarm of active) {
    const entry = previous[alarm.id];
    if (entry?.engine !== 'native' || !next[alarm.id]) continue;
    // A one-time AlarmManager trigger may be preserved across app launch or
    // editor changes. Refresh its interval metadata without touching trigger time.
    const updated = await updateNativeAlarmSnoozeMinutes(alarm.id, alarm.snooze_minutes ?? 10);
    if (!updated) console.warn('[MathWakeAlarm] could not refresh native Snooze metadata', { alarmId: alarm.id });
  }
  const activeNativeAlarmId = await getNativeActiveAlarmId();
  const removedEntries = Object.entries(previous)
    .filter(([id]) => !preservedIds.has(id));
  for (const [alarmId, entry] of removedEntries) {
    // A native one-shot has already fired when it appears in expiredOnceIds.
    // Its AlarmManager record is gone; cancelNativeAlarm() would also stop
    // the active foreground ringer while the challenge is still unsolved.
    if (
      entry.engine === 'native' &&
      !result.expiredOnceIds.includes(alarmId) &&
      activeNativeAlarmId !== alarmId
    ) {
      await cancelNativeAlarm(alarmId);
    } else if (entry.engine === 'native' && activeNativeAlarmId === alarmId) {
      console.info('[MathWakeAlarm] preserved active ringer during resync', { alarmId });
    }
  }
  if (N) await cancelIds(N, removedEntries.flatMap(([, entry]) => entry.ids));

  for (const alarm of active) {
    if (handled.has(alarm.id) && (next[alarm.id] || result.expiredOnceIds.includes(alarm.id))) {
      continue;
    }
    const outcome = await scheduleForAlarm(alarm);
    if (outcome.ids.length > 0 || outcome.engine === 'native') {
      next[alarm.id] = {
        ids: outcome.ids,
        target: outcome.target,
        ...(outcome.engine === 'native' ? { engine: 'native' as const } : {}),
      };
      result.scheduledCount += 1;
    } else {
      result.unscheduledActive += 1;
    }
  }
  await writeScheduleMap(next);
  return result;
}

export async function resyncSchedules(alarms: AlarmRow[]): Promise<ResyncResult> {
  return withScheduleMutationLock(() => resyncSchedulesUnlocked(alarms));
}

/** Cancels one alarm's schedules and drops it from the map. */
async function unscheduleAlarmUnlocked(alarmId: string): Promise<void> {
  const map = await readScheduleMap();
  const entry = map[alarmId];
  const ids = entry?.ids ?? [];
  delete map[alarmId];
  await writeScheduleMap(map);
  // Native engine (if it armed this alarm): cancel only the future
  // AlarmManager alarm and drop its persisted record. An already-fired ringer
  // remains active until the validated challenge-success path stops it.
  if (entry?.engine === 'native') {
    await cancelNativeAlarm(alarmId);
  }
  const N = await loadNotifications();
  if (N) await cancelIds(N, ids);
}

export async function unscheduleAlarm(alarmId: string): Promise<void> {
  return withScheduleMutationLock(() => unscheduleAlarmUnlocked(alarmId));
}

/** True when another occurrence of this schedule is already armed or live. */
export async function hasLaterScheduledOccurrence(
  alarmId: string,
  eventId: string,
  triggerAtMs: number,
): Promise<boolean> {
  const map = await readScheduleMap();
  const mappedTarget = map[alarmId]?.target ? Date.parse(map[alarmId].target!) : NaN;
  if (Number.isFinite(mappedTarget) && mappedTarget > triggerAtMs) return true;
  return (await hasNativeFutureAlarmSchedule(alarmId)) ||
    (await hasOtherNativeLiveOccurrence(alarmId, eventId));
}

/** Serializes one-shot completion with local schedule rebuilds and edits. */
export async function completeOnceOccurrenceIfCurrent(
  alarmId: string,
  eventId: string,
  triggerAtMs: number,
  deactivate: () => Promise<void>,
): Promise<boolean> {
  return withScheduleMutationLock(async () => {
    if (await hasLaterScheduledOccurrence(alarmId, eventId, triggerAtMs)) return false;
    await unscheduleAlarmUnlocked(alarmId);
    await deactivate();
    return true;
  });
}

let challengeListenerInstalled = false;
let autoStartListenerInstalled = false;

// ---------------------------------------------------------------------------
// Challenge notification handler
//
// When a MathWake alarm notification is tapped the OS delivers a
// NotificationResponse. This handler reads the alarmId from the notification
// payload, fetches the alarm's configuration from Supabase (to get difficulty
// and question_count), then navigates to the challenge screen.
//
// Design constraints:
// - Only installed once per app session (challengeListenerInstalled flag).
// - Verifies alarm ownership via the authenticated user before navigating
//   (reuses the getUserId dep from the same call site).
// - Does NOT deactivate the alarm here — that only happens after a successful
//   challenge completion, handled in challenge.tsx.
// - Navigation is via the router singleton from expo-router; safe to call
//   from outside React components.
// ---------------------------------------------------------------------------

export interface AlarmEntryDeps {
  getUserId: () => Promise<string | null>;
  /** Fetch difficulty and question_count for an alarm owned by userId. */
  fetchAlarmConfig: (
    userId: string,
    alarmId: string,
  ) => Promise<{ difficulty: string; question_count: number; title: string } | null>;
  /** Navigate to the reminder screen with the given params. */
  navigateToReminder: (params: {
    alarmId: string;
    alarmTitle: string;
    difficulty: string;
    questionCount: string;
    timeLimitSeconds: string;
    maxMistakes: string;
    eventId: string;
    generation: string;
    triggerAtMs: string;
  }) => void;
}

export interface AlarmOccurrenceIdentity {
  eventId: string;
  generation: string;
  triggerAtMs: number;
  native: boolean;
}

/**
 * Single-flight challenge entry with de-dup.
 *
 * Several sources can fire for the SAME alarm within milliseconds of each
 * other (notification tap + cold-start backstop, foreground auto-start +
 * native pending-alarm consumer, full-screen intent + tap). Without de-dup
 * the app would stack two challenge screens — and solving the first would
 * stop the audio while the second screen's mount effect restarts it.
 *
 * Same alarmId within the window: audio is (re-)ensured, navigation skipped.
 */
let lastChallengeEntry: { eventId: string; at: number } | null = null;
const CHALLENGE_ENTRY_DEDUP_MS = 3000;

export async function enterReminderFromAlarm(
  deps: AlarmEntryDeps,
  alarmId: string,
  source: 'tap' | 'cold-start' | 'auto-start' | 'pending',
  occurrence?: AlarmOccurrenceIdentity,
): Promise<void> {
  try {
    const now = Date.now();
    const identity = occurrence ?? {
      eventId: `expo:${alarmId}:${now}`,
      generation: `expo:${now}`,
      triggerAtMs: now,
      native: false,
    };
    if (
      lastChallengeEntry &&
      lastChallengeEntry.eventId === identity.eventId &&
      now - lastChallengeEntry.at < CHALLENGE_ENTRY_DEDUP_MS
    ) {
      await startAlarmAudio(alarmId, identity.eventId, identity.generation);
      return;
    }
    lastChallengeEntry = { eventId: identity.eventId, at: now };

    const userId = await deps.getUserId();
    if (!userId) {
      console.warn('[MathWake][Schedule] challenge entry: no authenticated user', {
        alarmId,
        source,
      });
      return;
    }

    const config = await deps.fetchAlarmConfig(userId, alarmId);
    if (!config) {
      console.warn('[MathWake][Schedule] challenge entry: alarm not found or not owned', {
        alarmId,
        source,
      });
      return;
    }

    // Start audio before navigating to the reminder. The reminder is the
    // deliberate user handoff into the challenge, including after unlock.
    // startAlarmAudio is idempotent — calling it twice for the same alarmId
    // is a no-op, so it won't start a second player if the user taps the
    // notification again while challenge is open.
    await startAlarmAudio(alarmId, identity.eventId, identity.generation);

    deps.navigateToReminder({
      alarmId,
      alarmTitle: config.title.trim().slice(0, 40) || 'Alarm',
      difficulty: config.difficulty,
      questionCount: String(config.question_count),
      // No per-alarm time/mistake limits in current schema — kept as 0.
      timeLimitSeconds: '0',
      maxMistakes: '0',
      eventId: identity.eventId,
      generation: identity.generation,
      triggerAtMs: String(identity.triggerAtMs),
    });
    if (identity.native) await acknowledgeNativePendingAlarm(identity.eventId, identity.generation);
  } catch (e) {
    console.warn(`[MathWake][Schedule] challenge navigation (${source}) failed:`, {
      message: e instanceof Error ? e.message : 'unknown',
    });
  }
}

/**
 * Cold-start consumer for native exact alarms: the receiver marks every fire
 * in SharedPreferences, so an app launched by the full-screen intent can
 * route to the challenge even before any notification tap is delivered.
 * Stale markers (older than PENDING_RECENCY_MS) are ignored.
 */
export async function consumePendingAlarmToReminder(
  deps: AlarmEntryDeps,
): Promise<boolean> {
  const pending = await consumeNativePendingAlarm();
  if (!pending) return false;
  if (Date.now() - pending.firedAtMs > PENDING_RECENCY_MS) return false;
  if (!pending.eventId || !pending.generation || typeof pending.triggerAtMs !== 'number') return false;
  await enterReminderFromAlarm(deps, pending.alarmId, 'pending', {
    eventId: pending.eventId,
    generation: pending.generation,
    triggerAtMs: pending.triggerAtMs,
    native: true,
  });
  return true;
}

function extractOccurrence(data: unknown, deliveredAt: number): { alarmId: string; identity: AlarmOccurrenceIdentity } | null {
  if (typeof data !== 'object' || data === null) return null;
  const row = data as { alarmId?: unknown; eventId?: unknown; generation?: unknown; triggerAtMs?: unknown };
  if (typeof row.alarmId !== 'string') return null;
  const eventId = typeof row.eventId === 'string' && row.eventId ? row.eventId : `expo:${row.alarmId}:${deliveredAt}`;
  const generation = typeof row.generation === 'string' && row.generation ? row.generation : `expo:${deliveredAt}`;
  const triggerAtMs = typeof row.triggerAtMs === 'number' ? row.triggerAtMs : deliveredAt;
  return { alarmId: row.alarmId, identity: { eventId, generation, triggerAtMs, native: eventId.startsWith('mw1:') } };
}

/**
 * Registers a notification-response listener that opens the challenge screen
 * when the user taps a MathWake alarm notification. Safe to call on every
 * app mount — the listener is installed at most once per process.
 *
 * The listener runs regardless of app state (foreground, background-resumed,
 * cold-launch). On cold launch, Expo delivers the response once the JS
 * context is ready, so this function must be called early in the root layout.
 * As a backstop for taps that launched the app before JS was ready, the last
 * notification response is also checked once right after install.
 */
export async function initChallengeNotificationHandler(
  deps: AlarmEntryDeps,
): Promise<void> {
  if (challengeListenerInstalled) return;
  const N = await loadNotifications();
  if (!N) return;
  challengeListenerInstalled = true;

  N.addNotificationResponseReceivedListener((response) => {
    const occurrence = extractOccurrence(response.notification.request.content.data, response.notification.date);
    if (!occurrence) return;
    void enterReminderFromAlarm(deps, occurrence.alarmId, 'tap', occurrence.identity);
  });

  // Cold-start backstop: if the app was launched from a notification tap
  // before the listener above was installed, the response is still available
  // via getLastNotificationResponse(). Handle it once, then clear it so a
  // later mount does not navigate twice.
  try {
    const last = N.getLastNotificationResponse();
    if (last?.notification) {
      const occurrence = extractOccurrence(last.notification.request.content.data, last.notification.date);
      if (occurrence) {
        await enterReminderFromAlarm(deps, occurrence.alarmId, 'cold-start', occurrence.identity);
        try {
          N.clearLastNotificationResponse();
        } catch {
          // Non-fatal: worst case the next mount re-handles the same tap,
          // and entry de-dup + idempotent audio keep it safe.
        }
      }
    }
  } catch (e) {
    console.warn('[MathWake][Schedule] cold-start notification check failed:', {
      message: e instanceof Error ? e.message : 'unknown',
    });
  }
}

/**
 * Auto-start loop: when an alarm notification is DELIVERED while the app is
 * running (foreground), start the looping alarm audio immediately — the user
 * does not need to tap first. Combined with the OS-level looping ringer
 * (native engine) or the OS notification sound (expo fallback), this is what
 * makes the alarm "berbunyi otomatis sesuai jadwal". Also navigates to the
 * challenge screen automatically.
 *
 * Honest limitation: when the app is killed or in the background, JS is not
 * running, so this listener cannot fire. In that state the native engine's
 * AlarmRingerService foreground service is already looping the alarm sound
 * (started directly by the receiver, no JS and no tap needed); once the app
 * is launched by the full-screen intent or a tap, the challenge mount effect
 * takes over the loop. With the expo fallback engine only the OS notification
 * sound plays until the user taps.
 */
export async function initAlarmAutoStart(deps: AlarmEntryDeps): Promise<void> {
  if (autoStartListenerInstalled) return;
  const N = await loadNotifications();
  if (!N) return;
  autoStartListenerInstalled = true;

  N.addNotificationReceivedListener((notification) => {
    const occurrence = extractOccurrence(notification.request.content.data, notification.date);
    if (!occurrence) return;
    void enterReminderFromAlarm(deps, occurrence.alarmId, 'auto-start', occurrence.identity);
  });
}
