import type { AlarmForm, ScheduleKind } from '@/lib/alarms';
import type { AlarmRingtone } from '@/lib/alarm-ringtones';
import { isSnoozeInterval, snoozeMinutesOrDefault } from '@/lib/alarms';

export type AlarmEditorDraft = {
  alarmId: string | null;
  form: AlarmForm;
  kind: ScheduleKind;
  ringtone: AlarmRingtone;
  savedAt: number;
};

export const ALARM_EDITOR_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY_PREFIX = 'mathwake.alarm-editor-draft.v1';

export function alarmEditorDraftKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}.${encodeURIComponent(userId)}`;
}

export function createAlarmEditorDraft(
  draft: Omit<AlarmEditorDraft, 'savedAt'>,
  savedAt = Date.now(),
): AlarmEditorDraft {
  return { ...draft, savedAt };
}

export function parseAlarmEditorDraft(
  raw: string | null,
  now = Date.now(),
): AlarmEditorDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AlarmEditorDraft>;
    const form = value.form as Partial<AlarmForm> | undefined;
    const ringtone = value.ringtone as Partial<AlarmRingtone> | undefined;
    const validRingtone = !!ringtone
      && ['mathwake', 'system', 'custom'].includes(String(ringtone.kind))
      && typeof ringtone.name === 'string'
      && (ringtone.uri === null || typeof ringtone.uri === 'string');
    if (
      (value.alarmId !== null && typeof value.alarmId !== 'string')
      || !form
      || typeof form.time !== 'string'
      || (form.title !== undefined && typeof form.title !== 'string')
      || !Array.isArray(form.days)
      || !form.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      || typeof form.is_recurring !== 'boolean'
      || typeof form.is_active !== 'boolean'
      || typeof form.difficulty !== 'string'
      || typeof form.question_count !== 'number'
      || (form.snooze_minutes !== undefined && !isSnoozeInterval(form.snooze_minutes))
      || !['once', 'daily', 'custom'].includes(String(value.kind))
      || !validRingtone
      || typeof value.savedAt !== 'number'
      || value.savedAt > now
      || now - value.savedAt > ALARM_EDITOR_DRAFT_MAX_AGE_MS
    ) return null;

    if (typeof form.title === 'string' && form.title.length > 40) return null;

    return {
      alarmId: value.alarmId ?? null,
      form: {
        ...form,
        title: typeof form.title === 'string' ? form.title.slice(0, 40) : '',
        snooze_minutes: snoozeMinutesOrDefault(form.snooze_minutes),
      } as AlarmForm,
      kind: value.kind as ScheduleKind,
      ringtone: ringtone as AlarmRingtone,
      savedAt: value.savedAt,
    };
  } catch {
    return null;
  }
}

export function applyCustomRingtoneResult(
  current: AlarmRingtone,
  result: { canceled: boolean; name?: string | null; uri?: string | null },
): AlarmRingtone {
  if (result.canceled || !result.uri) return current;
  return {
    kind: 'custom',
    name: result.name?.trim() || 'Audio kustom',
    uri: result.uri,
  };
}

/** Resume editor only from normal app entry routes; notification/deep links win. */
export function shouldResumeAlarmEditor(pathname: string): boolean {
  return pathname === '/' || pathname === '/alarms';
}
