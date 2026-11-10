import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  alarmEditorDraftKey,
  parseAlarmEditorDraft,
  type AlarmEditorDraft,
} from './alarm-editor-draft-logic';

export type { AlarmEditorDraft } from './alarm-editor-draft-logic';
export {
  alarmEditorDraftKey,
  applyCustomRingtoneResult,
  createAlarmEditorDraft,
  parseAlarmEditorDraft,
  shouldResumeAlarmEditor,
} from './alarm-editor-draft-logic';

let storageGeneration = 0;
let storageQueue: Promise<void> = Promise.resolve();

export async function loadAlarmEditorDraft(userId: string): Promise<AlarmEditorDraft | null> {
  try {
    const key = alarmEditorDraftKey(userId);
    const raw = await AsyncStorage.getItem(key);
    const draft = parseAlarmEditorDraft(raw);
    if (!draft && raw) await AsyncStorage.removeItem(key);
    return draft;
  } catch {
    return null;
  }
}

export function saveAlarmEditorDraft(userId: string, draft: AlarmEditorDraft): Promise<void> {
  const generation = ++storageGeneration;
  storageQueue = storageQueue.catch(() => undefined).then(async () => {
    if (generation !== storageGeneration) return;
    await AsyncStorage.setItem(alarmEditorDraftKey(userId), JSON.stringify(draft));
  });
  return storageQueue;
}

export function clearAlarmEditorDraft(userId: string): Promise<void> {
  const generation = ++storageGeneration;
  storageQueue = storageQueue.catch(() => undefined).then(async () => {
    if (generation !== storageGeneration) return;
    await AsyncStorage.removeItem(alarmEditorDraftKey(userId));
  });
  return storageQueue;
}
