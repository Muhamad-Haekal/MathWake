import { resolveActiveAlarm } from './alarm-active-state';
import type { AlarmSession } from './alarm-session';
import type { NativeActiveAlarmEvent, NativeAlarmEvent } from '../../modules/mathwake-alarm/src/types';

export interface ActiveChallengeOccurrence {
  alarmId: string;
  eventId: string;
  generation: string;
  triggerAtMs: number;
}

export function resolveActiveChallengeOccurrence(input: {
  alarmId: string;
  nativeActiveId: string | null;
  nativeOwner: NativeActiveAlarmEvent | null;
  nativeEvent: NativeAlarmEvent | null;
  session: AlarmSession | null;
  jsAudioPlaying: boolean;
  nowMs: number;
}): ActiveChallengeOccurrence | null {
  const { alarmId, nativeActiveId, nativeOwner, nativeEvent, session, jsAudioPlaying, nowMs } = input;

  if (nativeActiveId) {
    if (nativeActiveId !== alarmId || !nativeOwner || !nativeEvent) return null;
    if (
      nativeOwner.alarmId !== alarmId ||
      nativeOwner.eventId !== nativeEvent.eventId ||
      nativeOwner.generation !== nativeEvent.generation ||
      nativeEvent.alarmId !== alarmId ||
      nativeEvent.state !== 'ringing' ||
      !nativeEvent.eventId ||
      !nativeEvent.generation ||
      !Number.isFinite(nativeEvent.triggerAtMs)
    ) return null;
    return {
      alarmId,
      eventId: nativeEvent.eventId,
      generation: nativeEvent.generation,
      triggerAtMs: nativeEvent.triggerAtMs,
    };
  }

  if (!session || session.alarmId !== alarmId || !session.eventId || !session.generation) return null;
  // Native occurrences are authoritative. A persisted session survives JS
  // restarts, but it cannot prove that its native ringer is still active.
  // Require the native ownership branch above for native ledger event IDs.
  if (session.eventId.startsWith('mw1:')) return null;
  const active = resolveActiveAlarm({
    nativeActiveId: null,
    session,
    jsAudioPlaying,
    nowMs,
  });
  if (!active || active.alarmId !== alarmId) return null;
  const triggerAtMs = Number.isFinite(session.triggerAtMs) ? session.triggerAtMs : session.startedAt;
  if (!Number.isFinite(triggerAtMs) || triggerAtMs <= 0) return null;
  return { alarmId, eventId: session.eventId, generation: session.generation, triggerAtMs };
}

export function buildActiveChallengeParams(
  occurrence: ActiveChallengeOccurrence,
  config: {
    title?: string | null;
    difficulty?: string | null;
    questionCount?: number | null;
    timeLimitSeconds?: number | null;
    maxMistakes?: number | null;
  },
) {
  return {
    alarmId: occurrence.alarmId,
    eventId: occurrence.eventId,
    generation: occurrence.generation,
    triggerAtMs: String(occurrence.triggerAtMs),
    alarmTitle: typeof config.title === 'string' ? config.title.trim().slice(0, 40) || 'Alarm' : 'Alarm',
    difficulty: ['mudah', 'sedang', 'sulit'].includes(config.difficulty ?? '') ? config.difficulty! : 'sedang',
    questionCount: String(typeof config.questionCount === 'number' && config.questionCount >= 1
      ? Math.min(Math.floor(config.questionCount), 10)
      : 3),
    timeLimitSeconds: String(typeof config.timeLimitSeconds === 'number' && config.timeLimitSeconds > 0 ? config.timeLimitSeconds : 0),
    maxMistakes: String(typeof config.maxMistakes === 'number' && config.maxMistakes > 0 ? config.maxMistakes : 0),
  };
}
