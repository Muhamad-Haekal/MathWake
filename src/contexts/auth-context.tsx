import { Session, User } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useRef, useState } from 'react';

import { supabase } from '@/lib/supabase';

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
  signOut: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // undefined = not yet determined, null = no session, Session = authenticated
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;

    // 1. Fetch the current persisted session immediately.
    supabase.auth.getSession().then(({ data }) => {
      if (isMounted.current) {
        setSession(data.session ?? null);
      }
    });

    // 2. Subscribe to all future auth state changes.
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (isMounted.current) {
        setSession(newSession ?? null);
      }
    });

    return () => {
      isMounted.current = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    // onAuthStateChange will fire and set session to null.
  }

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
    isLoading: session === undefined,
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
