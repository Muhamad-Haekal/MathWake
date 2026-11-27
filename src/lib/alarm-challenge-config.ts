import AsyncStorage from '@react-native-async-storage/async-storage';

export interface AlarmChallengeConfig {
  alarmId: string;
  difficulty: 'mudah' | 'sedang' | 'sulit';
  question_count: number;
  title: string;
}

const KEY_PREFIX = 'mathwake:alarm-challenge-config:';

function normalizeConfig(value: unknown, alarmId: string): AlarmChallengeConfig | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Partial<AlarmChallengeConfig>;
  const difficulty = row.difficulty;
  if (
    row.alarmId !== alarmId ||
    (difficulty !== 'mudah' && difficulty !== 'sedang' && difficulty !== 'sulit') ||
    typeof row.question_count !== 'number' || !Number.isInteger(row.question_count) ||
    row.question_count < 1 || row.question_count > 10
  ) return null;
  return {
    alarmId,
    difficulty,
    question_count: row.question_count,
    title: typeof row.title === 'string' ? row.title.trim().slice(0, 40) || 'Alarm' : 'Alarm',
  };
}

export async function saveAlarmChallengeConfig(config: {
  alarmId: string;
  difficulty: string;
  question_count: number;
  title: string;
}): Promise<void> {
  const normalized = normalizeConfig(config, config.alarmId);
  if (!normalized) throw new Error('Konfigurasi tantangan alarm tidak valid.');
  await AsyncStorage.setItem(`${KEY_PREFIX}${config.alarmId}`, JSON.stringify(normalized));
}

export async function getAlarmChallengeConfig(alarmId: string): Promise<AlarmChallengeConfig | null> {
  try {
    const raw = await AsyncStorage.getItem(`${KEY_PREFIX}${alarmId}`);
    return raw ? normalizeConfig(JSON.parse(raw), alarmId) : null;
  } catch {
    return null;
  }
}

export async function removeAlarmChallengeConfig(alarmId: string): Promise<void> {
  await AsyncStorage.removeItem(`${KEY_PREFIX}${alarmId}`);
}

export async function cacheAlarmChallengeConfigs(
  rows: readonly { id: string; difficulty: string | null; question_count: number | null; title?: string | null }[],
): Promise<void> {
  await Promise.all(rows.map((row) => {
    if (row.difficulty !== 'mudah' && row.difficulty !== 'sedang' && row.difficulty !== 'sulit') return Promise.resolve();
    if (typeof row.question_count !== 'number' || !Number.isInteger(row.question_count) || row.question_count < 1 || row.question_count > 10) return Promise.resolve();
    return saveAlarmChallengeConfig({
      alarmId: row.id,
      difficulty: row.difficulty,
      question_count: row.question_count,
      title: row.title ?? 'Alarm',
    });
  }));
}
