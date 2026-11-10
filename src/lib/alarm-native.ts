import Constants, { AppOwnership } from 'expo-constants';
import { Platform } from 'react-native';

// Type-only import: erased at compile time, so it can never evaluate native
// code at runtime (Expo Go safe). The runtime module object is obtained via
// dynamic import() inside loadNativeAlarm().
import type { MathWakeAlarmModule as NativeAlarmModule } from '../../modules/mathwake-alarm';
import { parseRepeatDays, type AlarmRow } from './home-data';
import { snoozeMinutesOrDefault } from './alarms';
import { getAlarmRingtone, ringtoneToNativeUri } from './alarm-ringtones';
import type {
  NativeAlarmEvent,
  NativeAlarmEventState,
  NativeAlarmEventTransition,
  NativeAlarmStatus,
  NativePendingAlarm,
  NativeRingtonePickerResult,
} from '../../modules/mathwake-alarm/src/types';

// ---------------------------------------------------------------------------
// Native exact-alarm backend (Android dev build only).
//
// Uses the local Expo module `mathwake-alarm` (modules/mathwake-alarm):
// AlarmManager.setAlarmClock + full-screen intent that launches the app into
// /challenge even from a locked/killed state. Falls back to the
// expo-notifications path everywhere else (Expo Go, web, iOS, or when the
// native module reports unavailable).
//
// Like scheduling.ts, this module NEVER statically imports native code: the
// local module is dynamic-imported behind a capability check, so evaluating
// this file is side-effect free on every runtime.
// ---------------------------------------------------------------------------

/** Pending fires older than this are ignored by the cold-start consumer. */
export const PENDING_RECENCY_MS = 15 * 60 * 1000;

let cachedModule: NativeAlarmModule | null | undefined;

function isExpoGo(): boolean {
  try {
    return Constants.appOwnership === AppOwnership.Expo;
  } catch {
    return false;
  }
}

/** Capability-gated loader. Returns null off Android dev builds. Never throws. */
export async function loadNativeAlarm(): Promise<NativeAlarmModule | null> {
  if (cachedModule !== undefined) return cachedModule;
  if (Platform.OS !== 'android' || isExpoGo()) {
    cachedModule = null;
    return cachedModule;
  }
  try {
    const mod = await import('../../modules/mathwake-alarm');
    const candidate = (mod as { default?: unknown }).default;
    if (
      !candidate ||
      typeof (candidate as { getStatus?: unknown }).getStatus !== 'function' ||
      typeof (candidate as { scheduleAlarm?: unknown }).scheduleAlarm !== 'function'
    ) {
      cachedModule = null;
      return cachedModule;
    }
    cachedModule = candidate as NativeAlarmModule;
  } catch (e) {
    console.warn('[MathWake][NativeAlarm] native module unavailable:', {
      message: e instanceof Error ? e.message : 'unknown',
    });
    cachedModule = null;
  }
  return cachedModule;
}

const UNAVAILABLE_STATUS: NativeAlarmStatus = {
  available: false,
  canScheduleExactAlarms: false,
  canUseFullScreenIntent: false,
  reason: 'unavailable',
};

/** Runtime capability report. Safe on every platform; never throws. */
export async function getNativeAlarmStatus(): Promise<NativeAlarmStatus> {
  const mod = await loadNativeAlarm();
  if (!mod) return UNAVAILABLE_STATUS;
  try {
    const status = await mod.getStatus();
    if (!status || typeof status.available !== 'boolean') return UNAVAILABLE_STATUS;
    return {
      available: status.available,
      canScheduleExactAlarms: status.canScheduleExactAlarms === true,
      canUseFullScreenIntent: status.canUseFullScreenIntent === true,
    };
  } catch (e) {
    console.warn('[MathWake][NativeAlarm] getStatus failed:', {
      message: e instanceof Error ? e.message : 'unknown',
    });
    return UNAVAILABLE_STATUS;
  }
}

/** Deep link the native receiver fires: opens the reminder before challenge. */
export function buildAlarmReminderDeepLink(alarm: AlarmRow): string {
  const title = typeof alarm.title === 'string' ? alarm.title.trim().slice(0, 40) || 'Alarm' : 'Alarm';
  const difficulty =
    typeof alarm.difficulty === 'string' && alarm.difficulty ? alarm.difficulty : 'sedang';
  const count =
    typeof alarm.question_count === 'number' && alarm.question_count >= 1
      ? alarm.question_count
      : 3;
  const params =
    `alarmId=${encodeURIComponent(alarm.id)}` +
    `&difficulty=${encodeURIComponent(difficulty)}` +
    `&questionCount=${encodeURIComponent(String(count))}` +
    `&alarmTitle=${encodeURIComponent(title)}` +
    '&timeLimitSeconds=0&maxMistakes=0';
  return `mathwake://alarm-reminder?${params}`;
}

export interface NativeScheduleOutcome {
  scheduled: boolean;
  /** False when the OS denied exact alarms and an inexact fallback was used. */
  exact: boolean;
}

/**
 * Arms the native exact alarm for one occurrence. `when` must already be the
 * correct next firing time (computed by the caller with the same helpers the
 * expo path uses, so one-time/repeating semantics stay identical).
 */
export async function scheduleNativeAlarm(
  alarm: AlarmRow,
  when: Date,
): Promise<NativeScheduleOutcome> {
  const failed: NativeScheduleOutcome = { scheduled: false, exact: false };
  const mod = await loadNativeAlarm();
  if (!mod) return failed;
  const timeHHMM = alarm.time.slice(0, 5);
  const title = typeof alarm.title === 'string' ? alarm.title.trim().slice(0, 40) || 'Alarm' : 'Alarm';
  const ringtone = await getAlarmRingtone(alarm.id);
  const ringtoneUri = ringtoneToNativeUri(ringtone);
  console.info('[MathWakeRingtoneTrace] native-schedule', {
    alarmId: alarm.id,
    kind: ringtone.kind,
    scheme: ringtoneUri.split(':', 1)[0],
  });
  const repeat = parseRepeatDays(alarm.days);
  const daysCsv = repeat ? [...repeat].sort((a, b) => a - b).join(',') : '';
  try {
    console.info('[MathWake][NativeAlarm] scheduling:', {
      alarmId: alarm.id,
      triggerAtMs: when.getTime(),
      ringtoneKind: ringtone.kind,
    });
    const options = {
      alarmId: alarm.id,
      triggerAtMs: when.getTime(),
      deepLink: buildAlarmReminderDeepLink(alarm),
      timeHHMM,
      daysCsv,
      isRecurring: alarm.is_recurring !== false,
      ringtoneUri,
      alarmTitle: title,
      snoozeMinutes: snoozeMinutesOrDefault(alarm.snooze_minutes),
    };
    const hasSnoozeScheduleApi = typeof (mod as { scheduleAlarmWithSnooze?: unknown }).scheduleAlarmWithSnooze === 'function';
    const result = hasSnoozeScheduleApi
      ? await mod.scheduleAlarmWithSnooze!(options)
      : await mod.scheduleAlarm(
          alarm.id,
          when.getTime(),
          options.deepLink,
          timeHHMM,
          daysCsv,
          alarm.is_recurring !== false,
          ringtoneUri,
          title,
        );
    if (result?.scheduled === true && !hasSnoozeScheduleApi) {
      await updateNativeAlarmSnoozeMinutes(alarm.id, options.snoozeMinutes);
    }
    if (result && result.scheduled === true) {
      console.info('[MathWake][NativeAlarm] scheduled:', {
        alarmId: alarm.id,
        exact: result.exact === true,
      });
      return { scheduled: true, exact: result.exact === true };
    }
    console.warn('[MathWake][NativeAlarm] schedule declined:', {
      alarmId: alarm.id,
      reason:
        result && typeof result.reason === 'string' ? result.reason : 'unknown',
    });
    return failed;
  } catch (e) {
    console.warn('[MathWake][NativeAlarm] schedule failed:', {
      alarmId: alarm.id,
      message: e instanceof Error ? e.message : 'unknown',
    });
    return failed;
  }
}

/**
 * Cancels only the future AlarmManager schedule and its persisted record.
 *
 * This deliberately does not stop an already-fired ringer. A schedule can be
 * edited, disabled, or rebuilt while its challenge is still unsolved; the
 * active audio session is owned by the challenge-success path instead.
 */
export async function cancelNativeAlarm(alarmId: string): Promise<void> {
  const mod = await loadNativeAlarm();
  if (!mod) return;
  try {
    await mod.cancelAlarm(alarmId);
  } catch (e) {
    console.warn('[MathWake][NativeAlarm] cancel failed:', {
      alarmId,
      message: e instanceof Error ? e.message : 'unknown',
    });
  }
}

/** Refreshes Snooze metadata without changing the existing native trigger. */
export async function updateNativeAlarmSnoozeMinutes(alarmId: string, snoozeMinutes: number): Promise<boolean> {
  if (!alarmId || ![5, 10, 15, 20, 30].includes(snoozeMinutes)) return false;
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { updateAlarmSnoozeMinutes?: unknown }).updateAlarmSnoozeMinutes !== 'function') return false;
  try { return (await mod.updateAlarmSnoozeMinutes(alarmId, snoozeMinutes)) === true; } catch { return false; }
}

/** Removes the posted (sticky) alarm notification, if any. Never throws. */
export async function dismissNativeAlarmNotification(alarmId: string): Promise<void> {
  const mod = await loadNativeAlarm();
  if (!mod) return;
  try {
    await mod.dismissNotification(alarmId);
  } catch (e) {
    console.warn('[MathWake][NativeAlarm] dismiss failed:', {
      alarmId,
      message: e instanceof Error ? e.message : 'unknown',
    });
  }
}

/**
 * Returns the last fired-but-unhandled alarm, or null. The native side
 * clears the marker on read. Callers must apply a recency check
 * (PENDING_RECENCY_MS) before acting on it.
 */
export async function consumeNativePendingAlarm(): Promise<NativePendingAlarm | null> {
  const mod = await loadNativeAlarm();
  if (!mod) return null;
  try {
    const pending = await mod.consumePendingAlarm();
    if (
      !pending ||
      typeof pending.alarmId !== 'string' ||
      typeof pending.firedAtMs !== 'number' ||
      !Number.isFinite(pending.firedAtMs)
    ) {
      return null;
    }
    return {
      alarmId: pending.alarmId,
      firedAtMs: pending.firedAtMs,
      ...(typeof pending.eventId === 'string' ? { eventId: pending.eventId } : {}),
      ...(typeof pending.generation === 'string' ? { generation: pending.generation } : {}),
      ...(typeof pending.triggerAtMs === 'number' && Number.isFinite(pending.triggerAtMs)
        ? { triggerAtMs: pending.triggerAtMs }
        : {}),
      ...(typeof pending.sessionId === 'string' ? { sessionId: pending.sessionId } : {}),
    };
  } catch (e) {
    console.warn('[MathWake][NativeAlarm] consume pending failed:', {
      message: e instanceof Error ? e.message : 'unknown',
    });
    return null;
  }
}

/** Reads one persisted native occurrence. Returns null when no ledger entry exists. */
export async function getNativeAlarmEvent(eventId: string): Promise<NativeAlarmEvent | null> {
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { getAlarmEvent?: unknown }).getAlarmEvent !== 'function') return null;
  try {
    const event = await mod.getAlarmEvent(eventId);
    if (
      !event || typeof event.alarmId !== 'string' || typeof event.eventId !== 'string' ||
      typeof event.triggerAtMs !== 'number' || typeof event.generation !== 'string' ||
      typeof event.state !== 'string'
    ) return null;
    return event;
  } catch {
    return null;
  }
}

/** Applies a generation-checked native lifecycle transition. */
export async function transitionNativeAlarmEvent(
  eventId: string,
  generation: string,
  targetState: NativeAlarmEventState,
): Promise<NativeAlarmEventTransition | null> {
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { transitionAlarmEvent?: unknown }).transitionAlarmEvent !== 'function') {
    return null;
  }
  try {
    return await mod.transitionAlarmEvent(eventId, generation, targetState);
  } catch {
    return null;
  }
}

/** Clears the pending marker when it belongs to alarmId. Never throws. */
export async function clearNativePendingAlarm(alarmId: string): Promise<void> {
  const mod = await loadNativeAlarm();
  if (!mod) return;
  try {
    await mod.clearPendingAlarm(alarmId);
  } catch (e) {
    console.warn('[MathWake][NativeAlarm] clear pending failed:', {
      alarmId,
      message: e instanceof Error ? e.message : 'unknown',
    });
  }
}

export async function acknowledgeNativePendingAlarm(eventId: string, generation: string): Promise<boolean> {
  if (!eventId || !generation) return false;
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { ackPendingAlarm?: unknown }).ackPendingAlarm !== 'function') return false;
  try { return (await mod.ackPendingAlarm(eventId, generation)) === true; } catch { return false; }
}

export async function dismissNativeEventNotification(eventId: string, generation: string): Promise<boolean> {
  if (!eventId || !generation) return false;
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { dismissEventNotification?: unknown }).dismissEventNotification !== 'function') return false;
  try { return (await mod.dismissEventNotification(eventId, generation)) === true; } catch { return false; }
}

export async function getNativeActiveAlarmEvent(): Promise<{ alarmId: string; eventId: string; generation: string } | null> {
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { getActiveAlarmEvent?: unknown }).getActiveAlarmEvent !== 'function') return null;
  try {
    const value = await mod.getActiveAlarmEvent();
    return value && typeof value.eventId === 'string' && typeof value.generation === 'string' && typeof value.alarmId === 'string' ? value : null;
  } catch { return null; }
}

export async function getNativeLiveAlarmIds(): Promise<string[]> {
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { getLiveAlarmIds?: unknown }).getLiveAlarmIds !== 'function') return [];
  try {
    const ids = await mod.getLiveAlarmIds();
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}

/** Opens the system "Alarms & reminders" settings (Android 12+). Never throws. */
export async function openNativeExactAlarmSettings(): Promise<boolean> {
  const mod = await loadNativeAlarm();
  if (!mod) return false;
  try {
    return (await mod.openExactAlarmSettings()) === true;
  } catch {
    return false;
  }
}

/**
 * Opens the system App info page for MathWake. This is the grant path for
 * the full-screen intent permission (Android 14+), which exposes no
 * dedicated settings intent — the toggle lives in the app's system pages.
 * Never throws.
 */
export async function openNativeAppInfoSettings(): Promise<boolean> {
  const mod = await loadNativeAlarm();
  if (!mod) return false;
  try {
    return (await mod.openAppInfoSettings()) === true;
  } catch {
    return false;
  }
}

export async function pickNativeAlarmRingtone(
  existingUri: string | null,
): Promise<NativeRingtonePickerResult | null> {
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { pickAlarmRingtone?: unknown }).pickAlarmRingtone !== 'function') {
    return null;
  }
  try {
    return await mod.pickAlarmRingtone(existingUri);
  } catch (e) {
    console.warn('[MathWake][NativeAlarm] ringtone picker failed:', {
      message: e instanceof Error ? e.message : 'unknown',
    });
    return null;
  }
}

export async function getNativeDefaultAlarmRingtoneUri(): Promise<string | null> {
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { getDefaultAlarmRingtoneUri?: unknown }).getDefaultAlarmRingtoneUri !== 'function') {
    return null;
  }
  try {
    const uri = await mod.getDefaultAlarmRingtoneUri();
    return typeof uri === 'string' && uri ? uri : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OS-level looping ringer (AlarmRingerService) — handoff control.
//
// The native receiver starts a foreground service that loops the alarm sound
// the moment the alarm fires, so it rings immediately on the lock screen / in
// the background — no notification tap required. Once the app is in the
// foreground and the JS expo-audio loop is playing, JS must coordinate with it
// so the two never overlap:
//
//   muteNativeRing(alarmId)  → pause the OS loop, keep its sticky notification
//                              (audio handoff into expo-audio).
//   stopNativeRing(alarmId)  → full silence + remove notification + stop the
//                              foreground service (valid success / cancel).
// ---------------------------------------------------------------------------

/** Pauses the OS-level ringer for this alarm if it is active. Never throws. */
export async function muteNativeRing(eventId: string, generation: string): Promise<boolean> {
  if (!eventId || !generation) return false;
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { muteRing?: unknown }).muteRing !== 'function') return false;
  try {
    return (await mod.muteRing(eventId, generation)) === true;
  } catch (e) {
    console.warn('[MathWake][NativeAlarm] mute ring failed:', {
      eventId,
      message: e instanceof Error ? e.message : 'unknown',
    });
    return false;
  }
}

/**
 * Fully stops the OS-level ringer: silence, remove its notification, stop the
 * foreground service. alarmId null stops whatever is ringing. Never throws.
 */
export async function getNativeActiveAlarmId(): Promise<string | null> {
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { getActiveAlarmId?: unknown }).getActiveAlarmId !== 'function') return null;
  try {
    const id = await mod.getActiveAlarmId();
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

export async function hasNativeFutureAlarmSchedule(alarmId: string): Promise<boolean> {
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { hasFutureAlarmSchedule?: unknown }).hasFutureAlarmSchedule !== 'function') return false;
  try { return (await mod.hasFutureAlarmSchedule(alarmId)) === true; } catch { return false; }
}

export async function hasOtherNativeLiveOccurrence(alarmId: string, eventId: string): Promise<boolean> {
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { hasOtherLiveAlarmOccurrence?: unknown }).hasOtherLiveAlarmOccurrence !== 'function') return false;
  try { return (await mod.hasOtherLiveAlarmOccurrence(alarmId, eventId)) === true; } catch { return false; }
}

/** True only while the native ringer is audibly playing this alarm. */
export async function isNativeRingPlaying(eventId: string, generation: string): Promise<boolean> {
  if (!eventId || !generation) return false;
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { isRinging?: unknown }).isRinging !== 'function') return false;
  try {
    return await mod.isRinging(eventId, generation);
  } catch {
    return false;
  }
}

export async function stopNativeRing(eventId: string, generation: string): Promise<boolean> {
  if (!eventId || !generation) return false;
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { stopRing?: unknown }).stopRing !== 'function') return false;
  try {
    return (await mod.stopRing(eventId, generation)) === true;
  } catch (e) {
    console.warn('[MathWake][NativeAlarm] stop ring failed:', {
      eventId,
      message: e instanceof Error ? e.message : 'unknown',
    });
    return false;
  }
}

/** Creates a new native Snooze occurrence for the exact active occurrence. */
export async function snoozeNativeRing(
  alarmId: string,
  eventId: string,
  generation: string,
  intervalMinutes: number,
): Promise<import('../../modules/mathwake-alarm/src/types').NativeSnoozeResult | null> {
  if (!alarmId || !eventId || !generation || ![5, 10, 15, 20, 30].includes(intervalMinutes)) return null;
  const mod = await loadNativeAlarm();
  if (!mod || typeof (mod as { snoozeRing?: unknown }).snoozeRing !== 'function') return null;
  try {
    const result = await mod.snoozeRing(alarmId, eventId, generation, intervalMinutes);
    if (!result || typeof result.success !== 'boolean') return null;
    return result;
  } catch (e) {
    console.warn('[MathWake][NativeAlarm] snooze failed:', {
      alarmId,
      eventId,
      message: e instanceof Error ? e.message : 'unknown',
    });
    return null;
  }
}
