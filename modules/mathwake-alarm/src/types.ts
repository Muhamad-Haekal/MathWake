export interface NativeAlarmStatus {
  available: boolean;
  canScheduleExactAlarms: boolean;
  canUseFullScreenIntent: boolean;
  reason?: string;
}


export interface NativeScheduleResult {
  scheduled: boolean;
  exact?: boolean;
  triggerAtMs?: number;
  reason?: string;
}

export interface NativeAlarmScheduleOptions {
  alarmId: string;
  triggerAtMs: number;
  deepLink: string;
  timeHHMM: string;
  daysCsv: string;
  isRecurring: boolean;
  ringtoneUri: string;
  alarmTitle: string;
  snoozeMinutes: number;
}

export interface NativeSnoozeResult {
  success: boolean;
  alreadyScheduled: boolean;
  eventId: string | null;
  generation: string | null;
  triggerAtMs: number | null;
  exact: boolean;
  reason?: string | null;
}

export interface NativePendingAlarm {
  alarmId: string;
  firedAtMs: number;
  eventId?: string;
  generation?: string;
  triggerAtMs?: number;
  sessionId?: string;
}

export type NativeAlarmEventState =
  | 'scheduled'
  | 'queued'
  | 'ringing'
  | 'snoozed'
  | 'completed'
  | 'stopped'
  | 'expired'
  | 'failed';

export interface NativeAlarmEvent {
  alarmId: string;
  eventId: string;
  triggerAtMs: number;
  generation: string;
  state: NativeAlarmEventState;
  firedAtMs: number | null;
  sessionId: string;
  revision: number;
  deepLink?: string;
  ringtoneUri?: string;
  isSnooze?: boolean;
  sourceEventId?: string | null;
  sourceGeneration?: string | null;
  rootEventId?: string | null;
  snoozeMinutes?: number | null;
  snoozedToEventId?: string | null;
}

export interface NativeActiveAlarmEvent {
  alarmId: string;
  eventId: string;
  generation: string;
}

export interface NativeAlarmEventTransition {
  result: 'updated' | 'already_in_state' | 'rejected' | 'missing';
  event: NativeAlarmEvent | null;
}

export interface NativeRingtonePickerResult {
  cancelled: boolean;
  uri?: string;
  name?: string;
  reason?: string;
}

export type MathWakeAlarmModuleEvents = {};
