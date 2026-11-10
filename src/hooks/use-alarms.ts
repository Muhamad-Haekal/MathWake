import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { useAuth } from '@/contexts/auth-context';
import {
    createAlarm,
    deleteAlarm,
    friendlyAlarmError,
    listAlarms,
    setAlarmActive,
    updateAlarm,
    type AlarmForm,
} from '@/lib/alarms';
import {
    clearNativePendingAlarm,
    dismissNativeAlarmNotification,
    getNativeActiveAlarmId,
    getNativeLiveAlarmIds,
} from '@/lib/alarm-native';
import { getAlarmSession } from '@/lib/alarm-session';
import type { AlarmRow } from '@/lib/home-data';
import {
    ensureSchedulePermission,
    forgetScheduleTarget,
    getSchedulePermission,
    resyncSchedules,
    unscheduleAlarm,
    type SchedulePermission,
} from '@/lib/scheduling';
import { supabase } from '@/lib/supabase';
import { removeAlarmRingtone, setAlarmRingtone, type AlarmRingtone } from '@/lib/alarm-ringtones';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

interface AlarmsState {
  alarms: AlarmRow[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  permission: SchedulePermission;
  /** Truthful scheduling footnote, e.g. when permission is missing. Null when all good. */
  scheduleNote: string | null;
  /** True when the OS denied exact alarms: UI should offer a settings shortcut. */
  needsExactAlarmSettings: boolean;
  /** True when the full-screen (lock-screen launch) grant is missing. */
  needsFullScreenSettings: boolean;
  busyId: string | null;
  refresh: () => Promise<void>;
  saveAlarm: (form: AlarmForm, alarmId?: string, ringtone?: AlarmRingtone) => Promise<AlarmRow | null>;
  toggleAlarm: (alarm: AlarmRow, isActive: boolean) => Promise<void>;
  removeAlarm: (alarmId: string) => Promise<void>;
  requestPermission: () => Promise<void>;
  openExactAlarmSettings: () => Promise<void>;
  openAppInfoSettings: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Reducer
// useReducer dispatch is BuiltInDispatch (not BuiltInSetState), so the React
// Compiler lint rule set-state-in-effect does not flag it.
// ---------------------------------------------------------------------------

interface LoadState {
  alarms: AlarmRow[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  permission: SchedulePermission;
  scheduleNote: string | null;
  /** True when the OS denied exact alarms: show a settings shortcut. */
  needsExactAlarmSettings: boolean;
  /** True when the full-screen (lock-screen launch) grant is missing. */
  needsFullScreenSettings: boolean;
}

type LoadAction =
  | { type: 'FETCH_START'; mode: 'initial' | 'refresh' }
  | {
      type: 'FETCH_SUCCESS';
      alarms: AlarmRow[];
      permission: SchedulePermission;
      scheduleNote: string | null;
      needsExactAlarmSettings: boolean;
      needsFullScreenSettings: boolean;
    }
  | { type: 'FETCH_ERROR'; message: string }
  | { type: 'FETCH_DONE' }
  | { type: 'NO_USER' }
  | { type: 'SET_PERMISSION'; permission: SchedulePermission };

const initialLoadState: LoadState = {
  alarms: [],
  isLoading: true,
  isRefreshing: false,
  error: null,
  permission: 'undetermined',
  scheduleNote: null,
  needsExactAlarmSettings: false,
  needsFullScreenSettings: false,
};

function loadReducer(state: LoadState, action: LoadAction): LoadState {
  switch (action.type) {
    case 'FETCH_START':
      return {
        ...state,
        isLoading: action.mode === 'initial' ? true : state.isLoading,
        isRefreshing: action.mode === 'refresh',
        error: null,
      };
    case 'FETCH_SUCCESS':
      return {
        ...state,
        alarms: action.alarms,
        permission: action.permission,
        scheduleNote: action.scheduleNote,
        needsExactAlarmSettings: action.needsExactAlarmSettings,
        needsFullScreenSettings: action.needsFullScreenSettings,
        error: null,
      };
    case 'FETCH_ERROR':
      return { ...state, error: action.message };
    case 'FETCH_DONE':
      return { ...state, isLoading: false, isRefreshing: false };
    case 'NO_USER':
      // Reset all user-specific state including permission and schedule note
      // so no data from the previous account lingers after logout.
      return {
        alarms: [],
        isLoading: false,
        isRefreshing: false,
        error: null,
        permission: 'undetermined',
        scheduleNote: null,
        needsExactAlarmSettings: false,
        needsFullScreenSettings: false,
      };
    case 'SET_PERMISSION':
      return { ...state, permission: action.permission };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Module-level fetch
//
// Accepts a `token` object whose `cancelled` flag is set to true when the
// fetch should be abandoned (component unmount or a newer request started).
// This prevents a slow, older request from overwriting the results of a
// newer one, and prevents any fetch from updating state after logout.
//
// The function is defined at module scope so the effect callback does not
// close over any React state setter — satisfying set-state-in-effect.
// ---------------------------------------------------------------------------

interface FetchToken {
  cancelled: boolean;
}

function buildScheduleNote(
  perm: SchedulePermission,
  unscheduledActive: number,
  nativeAlarmNote: string | null,
): string | null {
  if (perm === 'unsupported') {
    return 'Penjadwalan notifikasi tidak didukung di web. Alarm tetap tersimpan.';
  }
  if (perm === 'unavailable') {
    return 'Notifikasi tidak tersedia di Expo Go. Alarm tersimpan, tapi tidak dijadwalkan.';
  }
  if (perm !== 'granted') {
    return 'Izin notifikasi belum diberikan. Alarm tersimpan, tapi tidak dijadwalkan.';
  }
  if (unscheduledActive > 0) {
    return `${unscheduledActive} alarm aktif tidak dapat dijadwalkan di perangkat ini.`;
  }
  // Truthful engine note: the native exact alarm is armed, but the OS may
  // deny exact timing or full-screen launch — the alarm still fires, only
  // with weaker guarantees.
  return nativeAlarmNote;
}

/**
 * Native exact-alarm capability (Android dev build only; no-op elsewhere).
 * Returns the truthful footnote plus whether a settings shortcut applies.
 * A denial never blocks scheduling — the native engine falls back to
 * inexact — but the user deserves to know guarantees are weaker.
 */
async function getNativeAlarmState(): Promise<{
  note: string | null;
  needsExactAlarmSettings: boolean;
  needsFullScreenSettings: boolean;
}> {
  const none = {
    note: null,
    needsExactAlarmSettings: false,
    needsFullScreenSettings: false,
  };
  try {
    const { getNativeAlarmStatus } = await import('@/lib/alarm-native');
    const status = await getNativeAlarmStatus();
    if (!status.available) return none;
    if (!status.canScheduleExactAlarms) {
      return {
        note: 'Izin "Alarm & pengingat" belum diberikan di pengaturan sistem, jadi alarm bisa berbunyi tidak tepat waktu.',
        needsExactAlarmSettings: true,
        needsFullScreenSettings: false,
      };
    }
    if (!status.canUseFullScreenIntent) {
      return {
        note: 'Izin tampil di atas layar kunci belum diberikan, jadi alarm tidak membuka challenge otomatis. Nyalakan izinnya supaya alarm membangunkanmu.',
        needsExactAlarmSettings: false,
        needsFullScreenSettings: true,
      };
    }
    return none;
  } catch {
    return none;
  }
}

async function fetchAlarms(
  userId: string,
  token: FetchToken,
  dispatch: React.Dispatch<LoadAction>,
): Promise<void> {
  try {
    const rows = await listAlarms(supabase, userId);
    // Check after every await — user may have changed or component unmounted.
    if (token.cancelled) return;

    const perm = await getSchedulePermission();
    if (token.cancelled) return;

    let unscheduled = 0;
    let nativeNote: string | null = null;
    let needsExactAlarmSettings = false;
    let needsFullScreenSettings = false;

    // Always resync the native AlarmManager path. POST_NOTIFICATIONS controls
    // notification visibility, but it must not prevent the alarm service from
    // being armed and sounding. resyncSchedules() only uses Expo notifications
    // as a fallback when native scheduling is unavailable.
    const resync = await resyncSchedules(rows);
    if (token.cancelled) return;

    unscheduled = resync.unscheduledActive;

    // Native exact-alarm capability (Android dev build only; no-op
    // elsewhere). A denial does not block scheduling — the native engine
    // falls back to inexact — but the user deserves to know.
    const nativeState = await getNativeAlarmState();
    if (token.cancelled) return;
    nativeNote = nativeState.note;
    needsExactAlarmSettings = nativeState.needsExactAlarmSettings;
    needsFullScreenSettings = nativeState.needsFullScreenSettings;

    // Deactivate one-time alarms whose occurrence already passed.
    // User-scoped; a failure here never hides the list.
    if (resync.expiredOnceIds.length > 0) {
      await Promise.all(
        resync.expiredOnceIds.map((id) =>
          setAlarmActive(supabase, userId, id, false).catch(() => undefined),
        ),
      );
      if (token.cancelled) return;

      // The native engine may still hold a sticky notification (and a
      // pending marker) from the fired alarm — remove both so a solved/
      // expired alarm never rings or re-routes again. An alarm that is still
      // ringing or has an unsolved challenge session is skipped: only the
      // validated challenge-success path may tear its state down.
      const [ringingId, session] = await Promise.all([
        getNativeActiveAlarmId(),
        getAlarmSession(),
      ]);
      const liveAlarmIds = await getNativeLiveAlarmIds();
      const inFlight = new Set([ringingId, session?.alarmId, ...liveAlarmIds].filter((id): id is string => !!id));
      await Promise.all(
        resync.expiredOnceIds
          .filter((id) => !inFlight.has(id))
          .flatMap((id) => [
            dismissNativeAlarmNotification(id),
            clearNativePendingAlarm(id),
          ]),
      );
      if (token.cancelled) return;

      const fresh = await listAlarms(supabase, userId).catch(() => rows);
      if (token.cancelled) return;

      dispatch({
        type: 'FETCH_SUCCESS',
        alarms: fresh,
        permission: perm,
        scheduleNote: buildScheduleNote(perm, unscheduled, nativeNote),
        needsExactAlarmSettings,
        needsFullScreenSettings,
      });
      return;
    }

    if (token.cancelled) return;
    dispatch({
      type: 'FETCH_SUCCESS',
      alarms: rows,
      permission: perm,
      scheduleNote: buildScheduleNote(perm, unscheduled, nativeNote),
      needsExactAlarmSettings,
      needsFullScreenSettings,
    });
  } catch (e) {
    if (token.cancelled) return;
    console.warn('[MathWake][Alarms] load error:', {
      message: e instanceof Error ? e.message : 'unknown',
    });
    dispatch({ type: 'FETCH_ERROR', message: friendlyAlarmError(e) });
  } finally {
    if (!token.cancelled) {
      dispatch({ type: 'FETCH_DONE' });
    }
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Alarm list + mutations. Every mutation reloads from Supabase (source of
 * truth) and then rebuilds local notification schedules best-effort:
 * schedule failures never roll back or hide a saved alarm.
 *
 * Race-condition protection: each fetch receives a unique `token` object.
 * When a newer fetch starts, the previous token is cancelled, so any
 * in-flight response for the old fetch is silently discarded. The same
 * mechanism protects against account switches: the effect cleanup cancels
 * the previous user's fetch before the new user's fetch begins.
 */
export function useAlarms(): AlarmsState {
  const { user, isLoading: authLoading } = useAuth();
  const [state, dispatch] = useReducer(loadReducer, initialLoadState);
  const [busyId, setBusyId] = useState<string | null>(null);

  // currentToken tracks the active fetch so callers can cancel it.
  // Using a ref avoids re-renders and lets mutate() cancel a concurrent load.
  const currentToken = useRef<FetchToken>({ cancelled: false });

  // Helper: cancel any in-flight fetch, issue FETCH_START, and return a
  // promise that resolves when the fetch completes (or is cancelled).
  // Callers that need to await completion (refresh, mutate) use the returned
  // promise; the initial effect fires-and-forgets via the returned promise.
  const runFetch = useCallback(
    (userId: string, mode: 'initial' | 'refresh'): Promise<void> => {
      // Cancel previous request — its dispatch calls will be no-ops.
      currentToken.current.cancelled = true;
      const token: FetchToken = { cancelled: false };
      currentToken.current = token;
      dispatch({ type: 'FETCH_START', mode });
      return fetchAlarms(userId, token, dispatch);
    },
    [],
  );

  // Initial load + reload on user change.
  // Effect cleanup cancels the previous fetch so a slow request for the
  // previous user cannot overwrite state after the user switches or logs out.
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      currentToken.current.cancelled = true;
      dispatch({ type: 'NO_USER' });
      return;
    }
    void runFetch(user.id, 'initial');
    return () => {
      currentToken.current.cancelled = true;
    };
  }, [authLoading, user, runFetch]);

  const refresh = useCallback(async () => {
    if (authLoading || !user) return;
    await runFetch(user.id, 'refresh');
  }, [authLoading, user, runFetch]);

  const requestPermission = useCallback(async () => {
    const perm = await ensureSchedulePermission();
    dispatch({ type: 'SET_PERMISSION', permission: perm });
    if (authLoading || !user) return;
    await runFetch(user.id, 'refresh');
  }, [authLoading, user, runFetch]);

  /** Opens the system exact-alarm settings (Android 12+). No-op elsewhere. */
  const openExactAlarmSettings = useCallback(async () => {
    const { openNativeExactAlarmSettings } = await import('@/lib/alarm-native');
    await openNativeExactAlarmSettings();
  }, []);

  /**
   * Opens the system App info page (grant path for the Android 14+
   * full-screen intent permission). No-op elsewhere.
   */
  const openAppInfoSettings = useCallback(async () => {
    const { openNativeAppInfoSettings } = await import('@/lib/alarm-native');
    await openNativeAppInfoSettings();
  }, []);

  /** Runs fn, then reloads + resyncs. Returns true on success. */
  const mutate = useCallback(
    async <T>(busyKey: string, fn: () => Promise<T>): Promise<T | null> => {
      if (!user) return null;
      setBusyId(busyKey);
      try {
        const result = await fn();
        // Cancel any concurrent load (e.g. a refresh racing with this mutation)
        // then do an authoritative reload.
        await runFetch(user.id, 'refresh');
        return result;
      } catch (e) {
        console.warn('[MathWake][Alarms] mutation error:', {
          message: e instanceof Error ? e.message : 'unknown',
        });
        dispatch({ type: 'FETCH_ERROR', message: friendlyAlarmError(e) });
        dispatch({ type: 'FETCH_DONE' });
        return null;
      } finally {
        setBusyId(null);
      }
    },
    [user, runFetch],
  );

  const saveAlarm = useCallback(
    (form: AlarmForm, alarmId?: string, ringtone?: AlarmRingtone) => {
      if (!user) return Promise.resolve(null);
      return mutate(alarmId ?? 'new', async () => {
        const row = alarmId
          ? await updateAlarm(supabase, user.id, alarmId, form)
          : await createAlarm(supabase, user.id, form);
        // Persist the per-alarm ringtone before mutate() reloads and resyncs
        // schedules. Otherwise the scheduler reads the previous/default tone.
        if (ringtone) {
          try {
            await setAlarmRingtone(row.id, ringtone);
            console.info('[MathWakeRingtoneTrace] saved', {
              alarmId: row.id,
              kind: ringtone.kind,
              scheme: ringtone.uri?.split(':', 1)[0] ?? 'none',
            });
          } catch (e) {
            console.warn('[MathWake][Alarms] ringtone persistence failed:', {
              alarmId: row.id,
              message: e instanceof Error ? e.message : 'unknown',
            });
            throw e;
          }
        }
        await forgetScheduleTarget(row.id);
        return row;
      });
    },
    [user, mutate],
  );

  const toggleAlarm = useCallback(
    (alarm: AlarmRow, isActive: boolean) => {
      if (!user) return Promise.resolve();
      return mutate(alarm.id, async () => {
        if (!isActive) {
          await unscheduleAlarm(alarm.id);
        } else {
          await forgetScheduleTarget(alarm.id);
        }
        await setAlarmActive(supabase, user.id, alarm.id, isActive);
      }).then(() => undefined);
    },
    [user, mutate],
  );

  const removeAlarm = useCallback(
    (alarmId: string) => {
      if (!user) return Promise.resolve();
      return mutate(alarmId, async () => {
        await unscheduleAlarm(alarmId);
        await deleteAlarm(supabase, user.id, alarmId);
        await removeAlarmRingtone(alarmId);
      }).then(() => undefined);
    },
    [user, mutate],
  );

  return {
    alarms: state.alarms,
    isLoading: state.isLoading,
    isRefreshing: state.isRefreshing,
    error: state.error,
    permission: state.permission,
    scheduleNote: state.scheduleNote,
    needsExactAlarmSettings: state.needsExactAlarmSettings,
    needsFullScreenSettings: state.needsFullScreenSettings,
    busyId,
    refresh,
    saveAlarm,
    toggleAlarm,
    removeAlarm,
    requestPermission,
    openExactAlarmSettings,
    openAppInfoSettings,
  };
}
