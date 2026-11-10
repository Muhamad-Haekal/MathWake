import { Session, User } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { registerSupabaseAuthLifecycle, supabase } from '@/lib/supabase';
import {
  clearRecoveryMarker,
  RECOVERY_MARKER_MAX_AGE_MS,
  saveRecoveryMarker,
} from '@/lib/password-recovery';
import { fetchMyProfile, type Profile } from '@/lib/profile';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthContextValue {
  /** Supabase session, null when signed out, undefined while loading. */
  session: Session | null | undefined;
  /** Convenience — the user object from the active session. */
  user: User | null;
  /** True while the initial session check is in flight. */
  isLoading: boolean;
  /** True only while a verified password-recovery session is active. */
  recoveryActive: boolean;
  /** Expiry of the in-memory recovery authorization. */
  recoveryExpiresAt: number | null;
  profile: Profile | null;
  profileLoading: boolean;
  profileError: string | null;
  onboardingRequired: boolean;
  refreshProfile: () => Promise<void>;
  markRecoveryVerified: (session: Session) => Promise<void>;
  clearRecovery: () => Promise<boolean>;
  signOut: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

type AuthErrorShape = {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
  status?: unknown;
};

function authErrorFields(error: unknown) {
  const value = error as AuthErrorShape;
  return {
    message: typeof value.message === 'string'
      ? value.message
      : error instanceof Error ? error.message : 'unknown',
    code: typeof value.code === 'string' ? value.code : undefined,
    details: typeof value.details === 'string' ? value.details : undefined,
    hint: typeof value.hint === 'string' ? value.hint : undefined,
    status: typeof value.status === 'number' ? value.status : undefined,
  };
}

function logAuthEvent(event: string) {
  if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED' || event === 'SIGNED_OUT') {
    console.info('[MathWake][Auth] event:', event);
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // undefined = not yet determined, null = no session, Session = authenticated
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [recoveryActive, setRecoveryActive] = useState(false);
  const [recoveryExpiresAt, setRecoveryExpiresAt] = useState<number | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const isMounted = useRef(true);
  const recoveryUserId = useRef<string | null>(null);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const profileRequestVersion = useRef(0);

  const cancelRecoveryTimer = useCallback(() => {
    if (recoveryTimer.current !== null) {
      clearTimeout(recoveryTimer.current);
      recoveryTimer.current = null;
    }
  }, []);

  const markRecoveryVerified = useCallback(async (recoverySession: Session) => {
    cancelRecoveryTimer();
    const expiresAt = Date.now() + RECOVERY_MARKER_MAX_AGE_MS;
    recoveryUserId.current = recoverySession.user.id;
    setRecoveryActive(true);
    setRecoveryExpiresAt(expiresAt);
    recoveryTimer.current = setTimeout(() => {
      recoveryTimer.current = null;
      if (!isMounted.current) return;
      recoveryUserId.current = null;
      setRecoveryActive(false);
      setRecoveryExpiresAt(null);
      void clearRecoveryMarker().catch(() => undefined);
    }, RECOVERY_MARKER_MAX_AGE_MS);
    try {
      await saveRecoveryMarker(recoverySession.user.id, expiresAt - RECOVERY_MARKER_MAX_AGE_MS);
    } catch {
      // The in-memory PASSWORD_RECOVERY event remains the authority for this process.
    }
  }, [cancelRecoveryTimer]);

  const clearRecovery = useCallback(async (): Promise<boolean> => {
    cancelRecoveryTimer();
    recoveryUserId.current = null;
    setRecoveryActive(false);
    setRecoveryExpiresAt(null);
    try {
      await clearRecoveryMarker();
      return true;
    } catch {
      return false;
    }
  }, [cancelRecoveryTimer]);

  const refreshProfile = useCallback(async () => {
    if (!session) {
      profileRequestVersion.current += 1;
      setProfile(null);
      setProfileError(null);
      setProfileLoading(false);
      return;
    }

    if (recoveryActive) {
      setProfileLoading(false);
      setProfileError(null);
      return;
    }

    const requestVersion = ++profileRequestVersion.current;
    const userId = session.user.id;
    setProfileLoading(true);
    setProfileError(null);
    const result = await fetchMyProfile(userId);

    if (!isMounted.current || requestVersion !== profileRequestVersion.current) return;
    if (result.error || !result.data) {
      setProfile(null);
      setProfileError('Profil pengguna belum dapat diverifikasi. Periksa koneksi lalu coba lagi.');
      setProfileLoading(false);
      return;
    }
    setProfile(result.data);
    setProfileError(null);
    setProfileLoading(false);
  }, [recoveryActive, session]);

  useEffect(() => {
    isMounted.current = true;
    let authEventVersion = 0;
    const cleanupAuthLifecycle = registerSupabaseAuthLifecycle();

    // A persisted marker is never recovery authorization after a process restart.
    void clearRecoveryMarker().catch(() => undefined);

    // Subscribe before reading storage so an auth event cannot be missed.
    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      authEventVersion += 1;
      logAuthEvent(event);
      if (isMounted.current) {
        setSession(newSession ?? null);
      }
      if (event === 'PASSWORD_RECOVERY' && newSession) {
        void markRecoveryVerified(newSession);
      } else if (event === 'SIGNED_OUT') {
        void clearRecovery();
      } else if (event === 'SIGNED_IN') {
        // OTP recovery can emit SIGNED_IN after the screen has verified and
        // marked the same user's recovery session. Preserve only that verified
        // same-user state; ordinary/different-user logins clear stale state.
        if (!newSession || recoveryUserId.current !== newSession.user.id) {
          void clearRecovery();
        }
      } else if (newSession && recoveryUserId.current && recoveryUserId.current !== newSession.user.id) {
        void clearRecovery();
      }
    });

    // The event version prevents an older storage read from overwriting a
    // newer session event (for example TOKEN_REFRESHED or SIGNED_OUT).
    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) {
        console.warn('[MathWake][Auth] getSession error:', authErrorFields(error));
        if (isMounted.current && authEventVersion === 0) setSession(null);
        return;
      }
      if (isMounted.current && authEventVersion === 0) {
        setSession(data.session ?? null);
      }
    }).catch((error: unknown) => {
      console.warn('[MathWake][Auth] getSession exception:', authErrorFields(error));
      if (isMounted.current && authEventVersion === 0) setSession(null);
    });

    return () => {
      isMounted.current = false;
      cancelRecoveryTimer();
      listener.subscription.unsubscribe();
      cleanupAuthLifecycle();
    };
  }, [cancelRecoveryTimer, clearRecovery, markRecoveryVerified]);

  useEffect(() => {
    void Promise.resolve().then(refreshProfile).catch(() => {
      if (!isMounted.current) return;
      setProfile(null);
      setProfileError('Profil pengguna belum dapat diverifikasi. Periksa koneksi lalu coba lagi.');
      setProfileLoading(false);
    });
  }, [refreshProfile]);

  async function signOut() {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        const fields = authErrorFields(error);
        console.warn('[MathWake][Auth] signOut error:', {
          code: fields.code,
          status: fields.status,
        });
        throw new Error('sign out failed');
      }
      setSession(null);
    } finally {
      await clearRecovery();
    }
    // onAuthStateChange will fire and set session to null.
  }

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
    isLoading: session === undefined,
    recoveryActive,
    recoveryExpiresAt,
    profile,
    profileLoading,
    profileError,
    onboardingRequired: !!session
      && !profileLoading
      && !profileError
      && !!profile
      && profile.id === session.user.id
      && !profile.onboarding_completed,
    refreshProfile,
    markRecoveryVerified,
    clearRecovery,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
