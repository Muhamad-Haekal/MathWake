import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/contexts/auth-context';
import { supabase } from '@/lib/supabase';
import {
  createAlarm,
  deleteAlarm,
  friendlyAlarmError,
  listAlarms,
  setAlarmActive,
  updateAlarm,
  type AlarmForm,
} from '@/lib/alarms';
import type { AlarmRow } from '@/lib/home-data';
import {
  ensureSchedulePermission,
  forgetScheduleTarget,
  getSchedulePermission,
  resyncSchedules,
  unscheduleAlarm,
  type SchedulePermission,
} from '@/lib/scheduling';

interface AlarmsState {
  alarms: AlarmRow[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  permission: SchedulePermission;
  /** Truthful scheduling footnote, e.g. when permission is missing. Null when all good. */
  scheduleNote: string | null;
  busyId: string | null;
  refresh: () => Promise<void>;
  saveAlarm: (form: AlarmForm, alarmId?: string) => Promise<boolean>;
  toggleAlarm: (alarm: AlarmRow, isActive: boolean) => Promise<void>;
  removeAlarm: (alarmId: string) => Promise<void>;
  requestPermission: () => Promise<void>;
}

/**
 * Alarm list + mutations. Every mutation reloads from Supabase (source of
 * truth) and then rebuilds local notification schedules best-effort:
 * schedule failures never roll back or hide a saved alarm.
 */
export function useAlarms(): AlarmsState {
  const { user } = useAuth();
  const [alarms, setAlarms] = useState<AlarmRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<SchedulePermission>('undetermined');
  const [scheduleNote, setScheduleNote] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const applyScheduleNote = useCallback(
    (perm: SchedulePermission, unscheduledActive: number) => {
      if (!isMounted.current) return;
      if (perm === 'unsupported') {
        setScheduleNote('Penjadwalan notifikasi tidak didukung di web. Alarm tetap tersimpan.');
      } else if (perm === 'unavailable') {
        setScheduleNote(
          'Notifikasi tidak tersedia di Expo Go. Alarm tersimpan, tapi tidak dijadwalkan.',
        );
      } else if (perm !== 'granted') {
        setScheduleNote('Izin notifikasi belum diberikan. Alarm tersimpan, tapi tidak dijadwalkan.');
      } else if (unscheduledActive > 0) {
        setScheduleNote(
          `${unscheduledActive} alarm aktif tidak dapat dijadwalkan di perangkat ini.`,
        );
      } else {
        setScheduleNote(null);
      }
    },
    [],
  );

  const load = useCallback(async (mode: 'initial' | 'refresh' = 'initial') => {
    if (!user) {
      if (isMounted.current) {
        setAlarms([]);
        setError(null);
        setIsLoading(false);
        setIsRefreshing(false);
      }
      return;
    }
    if (isMounted.current) {
      if (mode === 'initial') setIsLoading(true);
      else setIsRefreshing(true);
      setError(null);
    }
    try {
      const rows = await listAlarms(supabase, user.id);
      const perm = await getSchedulePermission();
      let unscheduled = 0;
      if (perm === 'granted') {
        const resync = await resyncSchedules(rows);
        unscheduled = resync.unscheduledActive;
        // One-time alarms whose occurrence passed are finished: deactivate
        // them in the database so they never re-arm on the next open.
        // User-scoped updates only; a failure here never hides the list.
        if (resync.expiredOnceIds.length > 0 && isMounted.current) {
          await Promise.all(
            resync.expiredOnceIds.map((id) =>
              setAlarmActive(supabase, user.id, id, false).catch(() => undefined),
            ),
          );
          const fresh = await listAlarms(supabase, user.id).catch(() => rows);
          if (isMounted.current) {
            setAlarms(fresh);
            setPermission(perm);
            applyScheduleNote(perm, unscheduled);
            return;
          }
        }
      } else {
        unscheduled = rows.filter((a) => a.is_active).length;
      }
      if (isMounted.current) {
        setAlarms(rows);
        setPermission(perm);
        applyScheduleNote(perm, unscheduled);
      }
    } catch (e) {
      console.warn('[MathWake][Alarms] load error:', {
        message: e instanceof Error ? e.message : 'unknown',
      });
      if (isMounted.current) setError(friendlyAlarmError(e));
    } finally {
      if (isMounted.current) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [user, applyScheduleNote]);

  useEffect(() => {
    load('initial');
  }, [load]);

  const refresh = useCallback(() => load('refresh'), [load]);

  const requestPermission = useCallback(async () => {
    const perm = await ensureSchedulePermission();
    if (isMounted.current) setPermission(perm);
    await load();
  }, [load]);

  /** Runs fn, then reloads + resyncs. Returns true on success. */
  const mutate = useCallback(
    async (busyKey: string, fn: () => Promise<void>): Promise<boolean> => {
      if (!user) return false;
      if (isMounted.current) {
        setBusyId(busyKey);
        setError(null);
      }
      try {
        await fn();
        await load('refresh');
        return true;
      } catch (e) {
        console.warn('[MathWake][Alarms] mutation error:', {
          message: e instanceof Error ? e.message : 'unknown',
        });
        if (isMounted.current) setError(friendlyAlarmError(e));
        return false;
      } finally {
        if (isMounted.current) setBusyId(null);
      }
    },
    [user, load],
  );

  const saveAlarm = useCallback(
    (form: AlarmForm, alarmId?: string) => {
      if (!user) return Promise.resolve(false);
      return mutate(alarmId ?? 'new', async () => {
        // A fresh save means a fresh occurrence: drop any recorded
        // one-time target so it can never deactivate the edited alarm.
        const row = alarmId
          ? await updateAlarm(supabase, user.id, alarmId, form)
          : await createAlarm(supabase, user.id, form);
        await forgetScheduleTarget(row.id);
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
          // Re-arming starts a fresh occurrence for one-time alarms.
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
      }).then(() => undefined);
    },
    [user, mutate],
  );

  return {
    alarms,
    isLoading,
    isRefreshing,
    error,
    permission,
    scheduleNote,
    busyId,
    refresh,
    saveAlarm,
    toggleAlarm,
    removeAlarm,
    requestPermission,
  };
}
