import AsyncStorage from '@react-native-async-storage/async-storage';

export interface AlarmSession {
  alarmId: string;
  eventId: string;
  generation: string;
  triggerAtMs: number;
  difficulty: string;
  questionCount: number;
  timeLimitSeconds: number;
  maxMistakes: number;
  startedAt: number;
}

const KEY = 'mathwake:active-alarm-session';

export async function saveAlarmSession(session: AlarmSession): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(session));
}

export async function getAlarmSession(): Promise<AlarmSession | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AlarmSession>;
    if (
      typeof value.alarmId !== 'string' || !value.alarmId ||
      typeof value.eventId !== 'string' || !value.eventId ||
      typeof value.generation !== 'string' || !value.generation ||
      typeof value.difficulty !== 'string' ||
      typeof value.questionCount !== 'number' || !Number.isFinite(value.questionCount) ||
      typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)
    ) return null;
    return {
      alarmId: value.alarmId,
      eventId: value.eventId,
      generation: value.generation,
      triggerAtMs: typeof value.triggerAtMs === 'number' ? value.triggerAtMs : value.startedAt as number,
      difficulty: value.difficulty,
      questionCount: value.questionCount,
      timeLimitSeconds: typeof value.timeLimitSeconds === 'number' ? value.timeLimitSeconds : 0,
      maxMistakes: typeof value.maxMistakes === 'number' ? value.maxMistakes : 0,
      startedAt: value.startedAt,
    };
  } catch {
    return null;
  }
}

export async function clearAlarmSession(eventId?: string): Promise<void> {
  if (eventId) {
    const current = await getAlarmSession();
    if (current && current.eventId !== eventId) return;
  }
  await AsyncStorage.removeItem(KEY);
}
