import { NativeModule, requireNativeModule } from 'expo';

import type {
  MathWakeAlarmModuleEvents,
  NativeAlarmEvent,
  NativeAlarmEventState,
  NativeAlarmEventTransition,
  NativeActiveAlarmEvent,
  NativeAlarmStatus,
  NativeAlarmScheduleOptions,
  NativePendingAlarm,
  NativeScheduleResult,
  NativeSnoozeResult,
  NativeRingtonePickerResult,
} from './types';

declare class MathWakeAlarmModule extends NativeModule<MathWakeAlarmModuleEvents> {
  scheduleAlarm: (
    alarmId: string,
    triggerAtMs: number,
    deepLink: string,
    timeHHMM: string,
    daysCsv: string,
    isRecurring: boolean,
    ringtoneUri: string,
    alarmTitle: string,
  ) => Promise<NativeScheduleResult>;
  scheduleAlarmWithSnooze?: (options: NativeAlarmScheduleOptions) => Promise<NativeScheduleResult>;
  scheduleTimer: (deadlineAtMs: number) => Promise<NativeScheduleResult>;
  cancelTimer: () => Promise<void>;
  cancelAlarm: (alarmId: string) => Promise<void>;
  updateAlarmSnoozeMinutes: (alarmId: string, snoozeMinutes: number) => Promise<boolean>;
  dismissNotification: (alarmId: string) => Promise<void>;
  dismissEventNotification: (eventId: string, generation: string) => Promise<boolean>;
  consumePendingAlarm: () => Promise<NativePendingAlarm | null>;
  clearPendingAlarm: (alarmId: string) => Promise<void>;
  ackPendingAlarm: (eventId: string, generation: string) => Promise<boolean>;
  getStatus: () => Promise<NativeAlarmStatus>;
  openExactAlarmSettings: () => Promise<boolean>;
  openAppInfoSettings: () => Promise<boolean>;

  /**
   * Pauses the OS-level looping ringer started by the alarm receiver but keeps
   * its sticky notification. Called by the JS audio engine when it takes over
   * playback so the two never overlap. No-op when the ringer is not active.
   */
  muteRing: (eventId: string, generation: string) => Promise<boolean>;
  /**
   * Full teardown of the OS-level ringer: silence, remove notification, stop
   * the foreground service. alarmId === null stops whatever is ringing.
   */
  stopRing: (eventId: string, generation: string) => Promise<boolean>;
  /** Schedules one new durable Snooze occurrence for the currently owned event. */
  snoozeRing: (
    alarmId: string,
    eventId: string,
    generation: string,
    intervalMinutes: number,
  ) => Promise<NativeSnoozeResult>;
  /** True only while the OS-level ringer is audibly playing for this alarm. */
  isRinging: (eventId: string, generation: string) => Promise<boolean>;
  getActiveAlarmId: () => Promise<string | null>;
  hasFutureAlarmSchedule: (alarmId: string) => Promise<boolean>;
  hasOtherLiveAlarmOccurrence: (alarmId: string, eventId: string) => Promise<boolean>;
  getActiveAlarmEvent: () => Promise<NativeActiveAlarmEvent | null>;
  getLiveAlarmIds: () => Promise<string[]>;
  getAlarmEvent: (eventId: string) => Promise<NativeAlarmEvent | null>;
  transitionAlarmEvent: (
    eventId: string,
    generation: string,
    targetState: NativeAlarmEventState,
  ) => Promise<NativeAlarmEventTransition>;
  pickAlarmRingtone: (existingUri: string | null) => Promise<NativeRingtonePickerResult>;
  getDefaultAlarmRingtoneUri: () => Promise<string | null>;
}

// Evaluated lazily: app code dynamic-imports this module behind a capability
// check (Android dev build only), so Expo Go / web never evaluate this line.
export default requireNativeModule<MathWakeAlarmModule>('MathWakeAlarm');

export type { MathWakeAlarmModule };
