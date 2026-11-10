import AsyncStorage from '@react-native-async-storage/async-storage';

export type RingtoneKind = 'mathwake' | 'system' | 'custom';

export interface AlarmRingtone {
  kind: RingtoneKind;
  name: string;
  uri: string | null;
}

const KEY_PREFIX = 'mathwake:alarm-ringtone:';

export const DEFAULT_ALARM_RINGTONE: AlarmRingtone = {
  kind: 'mathwake',
  name: 'Suara MathWake',
  uri: null,
};

export const SYSTEM_ALARM_RINGTONE: AlarmRingtone = {
  kind: 'system',
  name: 'Ringtone alarm Android',
  uri: 'android-system-alarm://default',
};

function key(alarmId: string): string {
  return `${KEY_PREFIX}${alarmId}`;
}

export async function getAlarmRingtone(alarmId: string): Promise<AlarmRingtone> {
  try {
    const raw = await AsyncStorage.getItem(key(alarmId));
    if (!raw) {
      console.info('[MathWakeRingtoneTrace] loaded-default', { alarmId, reason: 'no-storage-record' });
      return DEFAULT_ALARM_RINGTONE;
    }
    const parsed = JSON.parse(raw) as Partial<AlarmRingtone>;
    console.info('[MathWakeRingtoneTrace] loaded', {
      alarmId,
      kind: parsed.kind,
      scheme: typeof parsed.uri === 'string' ? parsed.uri.split(':', 1)[0] : 'none',
    });
    if (!['mathwake', 'system', 'custom'].includes(parsed.kind ?? '')) {
      console.warn('[MathWakeRingtoneTrace] fallback', { alarmId, reason: 'invalid-kind' });
      return DEFAULT_ALARM_RINGTONE;
    }
    if (parsed.kind === 'custom' && (!parsed.uri || typeof parsed.uri !== 'string')) {
      console.warn('[MathWakeRingtoneTrace] fallback', { alarmId, reason: 'custom-uri-missing' });
      return DEFAULT_ALARM_RINGTONE;
    }
    return {
      kind: parsed.kind as RingtoneKind,
      name: typeof parsed.name === 'string' && parsed.name ? parsed.name : DEFAULT_ALARM_RINGTONE.name,
      uri: typeof parsed.uri === 'string' ? parsed.uri : null,
    };
  } catch (e) {
    console.warn('[MathWakeRingtoneTrace] fallback', {
      alarmId,
      reason: e instanceof Error ? e.name : 'storage-read-failed',
    });
    return DEFAULT_ALARM_RINGTONE;
  }
}

export async function setAlarmRingtone(alarmId: string, ringtone: AlarmRingtone): Promise<void> {
  const safe = ringtone.kind === 'custom' && !ringtone.uri ? DEFAULT_ALARM_RINGTONE : ringtone;
  await AsyncStorage.setItem(key(alarmId), JSON.stringify(safe));
  console.info('[MathWakeRingtoneTrace] saved-storage', {
    alarmId,
    kind: safe.kind,
    scheme: safe.uri?.split(':', 1)[0] ?? 'none',
  });
}

export async function removeAlarmRingtone(alarmId: string): Promise<void> {
  await AsyncStorage.removeItem(key(alarmId));
}

export async function moveAlarmRingtone(fromAlarmId: string, toAlarmId: string): Promise<void> {
  const ringtone = await getAlarmRingtone(fromAlarmId);
  if (ringtone.kind !== DEFAULT_ALARM_RINGTONE.kind || ringtone.uri !== DEFAULT_ALARM_RINGTONE.uri) {
    await setAlarmRingtone(toAlarmId, ringtone);
  }
  await removeAlarmRingtone(fromAlarmId);
}

export function ringtoneToNativeUri(ringtone: AlarmRingtone): string {
  if (ringtone.kind === 'system') return SYSTEM_ALARM_RINGTONE.uri!;
  if (ringtone.kind === 'custom' && ringtone.uri) return ringtone.uri;
  return 'android-resource://alarm';
}
