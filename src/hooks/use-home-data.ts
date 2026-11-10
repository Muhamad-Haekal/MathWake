import { useCallback, useEffect, useReducer, useRef } from 'react';

import { useAuth } from '@/contexts/auth-context';
import { fetchHomeData, friendlyFetchError, type HomeData } from '@/lib/home-data';
import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

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
  logsToday: 0,
  attemptsToday: { total: 0, correct: 0 },
  attemptsUnavailable: false,
};

// ---------------------------------------------------------------------------
// Reducer
// useReducer dispatch is BuiltInDispatch (not BuiltInSetState) so the React
// Compiler lint rule set-state-in-effect does not flag it.
// ---------------------------------------------------------------------------

interface LoadState {
  data: HomeData | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
}

type LoadAction =
  | { type: 'FETCH_START'; mode: 'initial' | 'refresh' }
  | { type: 'FETCH_SUCCESS'; data: HomeData }
  | { type: 'FETCH_ERROR'; message: string }
  | { type: 'FETCH_DONE' }
  | { type: 'NO_USER' };

const initialState: LoadState = {
  data: null,
  isLoading: true,
  isRefreshing: false,
  error: null,
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
      return { ...state, data: action.data, error: null };
    case 'FETCH_ERROR':
      return { ...state, error: action.message };
    case 'FETCH_DONE':
      return { ...state, isLoading: false, isRefreshing: false };
    case 'NO_USER':
      // Clear all state on logout so no previous account's data lingers.
      return { data: EMPTY_DATA, error: null, isLoading: false, isRefreshing: false };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Module-level fetch
//
// Accepts a `token` object; checks `token.cancelled` after every await so
// a stale request for a previous user cannot overwrite the current user's
// data. Defined at module scope so the effect callback does not close over
// any React state setter, satisfying set-state-in-effect.
// ---------------------------------------------------------------------------

interface FetchToken {
  cancelled: boolean;
}

async function fetchHome(
  userId: string,
  token: FetchToken,
  dispatch: React.Dispatch<LoadAction>,
): Promise<void> {
  try {
    const result = await fetchHomeData(supabase, userId);
    if (token.cancelled) return;
    dispatch({ type: 'FETCH_SUCCESS', data: result });
  } catch (e) {
    if (token.cancelled) return;
    // Safe log: error message only, no email, tokens, or row data.
    console.warn('[MathWake][Home] fetchHomeData error:', {
      message: e instanceof Error ? e.message : 'unknown',
    });
    dispatch({ type: 'FETCH_ERROR', message: friendlyFetchError(e) });
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
 * Loads everything the Home dashboard needs in one place.
 * Loading and pull-to-refresh share the same fetch; errors are surfaced
 * as Indonesian copy, never raw Supabase messages or tokens.
 *
 * Race-condition protection: each fetch receives a unique token. When user
 * changes or a newer refresh starts, the previous token is cancelled so its
 * response is discarded and cannot overwrite the newer request's results.
 */
export function useHomeData(): HomeDataState {
  const { user, isLoading: authLoading } = useAuth();
  const [state, dispatch] = useReducer(loadReducer, initialState);

  // Tracks the active fetch token. Storing in a ref avoids re-renders and
  // lets runFetch() cancel any concurrent request synchronously.
  const currentToken = useRef<FetchToken>({ cancelled: false });

  // Cancel previous request and start a new fetch. Returns a promise that
  // resolves when the fetch completes or is cancelled.
  const runFetch = useCallback(
    (userId: string, mode: 'initial' | 'refresh'): Promise<void> => {
      currentToken.current.cancelled = true;
      const token: FetchToken = { cancelled: false };
      currentToken.current = token;
      dispatch({ type: 'FETCH_START', mode });
      return fetchHome(userId, token, dispatch);
    },
    [],
  );

  // Initial load + reload when user identity changes.
  // Cleanup cancels any in-flight request for the previous user before the
  // new user's request begins, preventing cross-account data leakage.
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

  return {
    data: state.data,
    isLoading: state.isLoading,
    isRefreshing: state.isRefreshing,
    error: state.error,
    refresh,
  };
}
