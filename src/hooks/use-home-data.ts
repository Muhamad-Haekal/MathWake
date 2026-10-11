import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/contexts/auth-context';
import { supabase } from '@/lib/supabase';
import { fetchHomeData, friendlyFetchError, type HomeData } from '@/lib/home-data';

interface HomeDataState {
  data: HomeData | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const EMPTY_DATA: HomeData = {
  activeAlarms: [],
  nextAlarm: null,
  routine: [],
  routineDone: 0,
  routineTotal: 0,
  logsToday: 0,
  attemptsToday: { total: 0, correct: 0 },
  attemptsUnavailable: false,
};

/**
 * Loads everything the Home dashboard needs in one place.
 * Loading and pull-to-refresh share the same fetch; errors are surfaced
 * as Indonesian copy, never raw Supabase messages or tokens.
 */
export function useHomeData(): HomeDataState {
  const { user } = useAuth();
  const [data, setData] = useState<HomeData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!user) {
        if (isMounted.current) {
          setData(EMPTY_DATA);
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
        const result = await fetchHomeData(supabase, user.id);
        if (isMounted.current) setData(result);
      } catch (e) {
        // Safe log: error code only, no email, tokens, or row data.
        console.warn('[MathWake][Home] fetchHomeData error:', {
          message: e instanceof Error ? e.message : 'unknown',
        });
        if (isMounted.current) setError(friendlyFetchError(e));
      } finally {
        if (isMounted.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [user],
  );

  useEffect(() => {
    load('initial');
  }, [load]);

  const refresh = useCallback(() => load('refresh'), [load]);

  return { data, isLoading, isRefreshing, error, refresh };
}
