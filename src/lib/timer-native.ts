import Constants, { AppOwnership } from 'expo-constants';
import { Platform } from 'react-native';

import { loadNativeAlarm } from './alarm-native';

export interface NativeTimerScheduleOutcome {
  scheduled: boolean;
  exact: boolean;
  reason?: string;
}

function isExpoGo(): boolean {
  try {
    return Constants.appOwnership === AppOwnership.Expo;
  } catch {
    return false;
  }
}

let operation = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = operation.catch(() => undefined).then(task);
  operation = next.then(() => undefined, () => undefined);
  return next;
}

/**
 * Schedules only the one Timer slot. This deliberately does not use any
 * alarm API, alarm ID, ringer control, or alarm session state.
 */
export function scheduleNativeTimer(deadlineAtMs: number): Promise<NativeTimerScheduleOutcome> {
  return enqueue(async () => {
    if (Platform.OS !== 'android' || isExpoGo()) {
      return { scheduled: false, exact: false, reason: 'unsupported-platform' };
    }
    if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= Date.now()) {
      const mod = await loadNativeAlarm();
      await mod?.cancelTimer?.();
      return { scheduled: false, exact: false, reason: 'deadline-past' };
    }
    const mod = await loadNativeAlarm();
    if (!mod || typeof mod.scheduleTimer !== 'function') {
      return { scheduled: false, exact: false, reason: 'native-module-unavailable' };
    }
    try {
      const result = await mod.scheduleTimer(deadlineAtMs);
      return {
        scheduled: result?.scheduled === true,
        exact: result?.exact === true,
        reason: typeof result?.reason === 'string' ? result.reason : undefined,
      };
    } catch (error) {
      console.warn('[MathWake][NativeTimer] schedule failed:', {
        message: error instanceof Error ? error.message : 'unknown',
      });
      return { scheduled: false, exact: false, reason: 'schedule-failed' };
    }
  });
}

export function cancelNativeTimer(): Promise<void> {
  return enqueue(async () => {
    if (Platform.OS !== 'android' || isExpoGo()) return;
    const mod = await loadNativeAlarm();
    if (!mod || typeof mod.cancelTimer !== 'function') return;
    try {
      await mod.cancelTimer();
    } catch (error) {
      console.warn('[MathWake][NativeTimer] cancel failed:', {
        message: error instanceof Error ? error.message : 'unknown',
      });
    }
  });
}
