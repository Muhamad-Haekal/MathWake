import type { AlarmSession } from './alarm-session';

/**
 * A persisted challenge session without live ringer evidence is trusted only
 * for this long after it was (re)saved. Display-only: the session itself is
 * never deleted here, only the validated challenge-success path clears it.
 */
export const SESSION_UNVERIFIED_MAX_AGE_MS = 60 * 60 * 1000;

export interface ActiveAlarmEvidence {
  /** alarmId owned by the native foreground ringer (audible or muted), or null. */
  nativeActiveId: string | null;
  /** Persisted challenge session, or null. */
  session: AlarmSession | null;
  /** True when the in-process JS alarm player is looping for session.alarmId. */
  jsAudioPlaying: boolean;
  nowMs: number;
}

export interface ActiveAlarmState {
  alarmId: string;
  /** Session matching alarmId (challenge params), or null when only native evidence exists. */
  session: AlarmSession | null;
  /** True when a live ringer (native or JS) confirms the alarm is sounding now. */
  verified: boolean;
}

/**
 * The alarm that has really fired and whose challenge is still unsolved.
 * Never derived from schedules, DB is_active flags, or alarm time proximity:
 * only from the native ringer, the live JS player, or a recent session that
 * an actual fire created (reminder/challenge mount).
 */
export function resolveActiveAlarm(e: ActiveAlarmEvidence): ActiveAlarmState | null {
  const session = e.session;
  if (e.nativeActiveId) {
    return {
      alarmId: e.nativeActiveId,
      session: session && session.alarmId === e.nativeActiveId ? session : null,
      verified: true,
    };
  }
  if (!session) return null;
  if (e.jsAudioPlaying) return { alarmId: session.alarmId, session, verified: true };
  const age = e.nowMs - session.startedAt;
  if (age >= 0 && age < SESSION_UNVERIFIED_MAX_AGE_MS) {
    return { alarmId: session.alarmId, session, verified: false };
  }
  return null;
}
