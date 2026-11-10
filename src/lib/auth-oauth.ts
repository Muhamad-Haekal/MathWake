import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { supabase } from '@/lib/supabase';
import {
  createCallbackUrlProcessor,
  processAuthCallback,
  type AuthCallbackKind,
  type AuthCallbackResult,
} from '@/lib/auth-callback-logic';

export const GOOGLE_REDIRECT_URI = 'mathwake://auth/callback';

export type OAuthResult = {
  success: boolean;
  handled: boolean;
  kind?: AuthCallbackKind;
  message?: string;
};

let callbackSubscription: { remove: () => void } | null = null;
let googleOAuthInProgress = false;

WebBrowser.maybeCompleteAuthSession();

function isAppAuthCallback(url: string): boolean {
  try {
    const parsed = Linking.parse(url);
    const path = parsed.path?.replace(/^\/+/, '') ?? '';
    return parsed.scheme === 'mathwake' && parsed.hostname === 'auth' && path === 'callback';
  } catch {
    return false;
  }
}

function toOAuthResult(result: AuthCallbackResult): OAuthResult {
  return {
    handled: result.handled,
    success: result.success,
    kind: result.kind,
    ...(result.message ? { message: result.message } : {}),
  };
}

async function processCallbackUrl(url: string, expectedKind: AuthCallbackKind): Promise<OAuthResult> {
  let parsed: ReturnType<typeof Linking.parse>;
  try {
    parsed = Linking.parse(url);
  } catch {
    return { handled: true, success: false, kind: expectedKind, message: 'Tautan autentikasi tidak valid. Minta tautan baru atau coba login kembali.' };
  }

  return toOAuthResult(await processAuthCallback(
    parsed.queryParams ?? {},
    expectedKind,
    async (code) => {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      // supabase-js 2.117.3 returns only user/session from this API. A recovery
      // callback is identified by the PASSWORD_RECOVERY auth event in context.
      return { error };
    },
  ));
}

const processCallbackUrlOnce = createCallbackUrlProcessor<OAuthResult, AuthCallbackKind>(
  (url, expectedKind) => processCallbackUrl(url, expectedKind ?? 'unknown'),
);

export function handleAuthCallbackUrl(
  url: string,
  expectedKind: AuthCallbackKind = 'unknown',
): Promise<OAuthResult> {
  if (!isAppAuthCallback(url)) {
    return Promise.resolve({ handled: false, success: false });
  }

  // The same callback URL can arrive via Linking and WebBrowser. The processor
  // caches the actual result, including failures, instead of turning repeats
  // into false successes. Browser initiated Google callbacks carry that intent.
  return processCallbackUrlOnce(url, expectedKind);
}

export function startAuthCallbackHandling(onResult?: (result: OAuthResult) => void): () => void {
  if (callbackSubscription) return () => undefined;

  callbackSubscription = Linking.addEventListener('url', ({ url }) => {
    if (googleOAuthInProgress) return;
    void handleAuthCallbackUrl(url).then((result) => {
      if (result.handled && (!result.success || result.kind === 'recovery')) onResult?.(result);
    }).catch(() => {
      onResult?.({
        handled: true,
        success: false,
        kind: 'unknown',
        message: 'Tautan autentikasi tidak dapat diproses. Coba login atau minta tautan reset baru.',
      });
    });
  });

  void Linking.getInitialURL().then((url) => {
    if (!url || googleOAuthInProgress) return;
    return handleAuthCallbackUrl(url).then((result) => {
      if (result.handled && (!result.success || result.kind === 'recovery')) onResult?.(result);
    });
  }).catch(() => {
    onResult?.({
      handled: true,
      success: false,
      kind: 'unknown',
      message: 'Tautan autentikasi tidak dapat dibaca. Coba login atau minta tautan reset baru.',
    });
  });

  return () => {
    callbackSubscription?.remove();
    callbackSubscription = null;
  };
}

export async function startGoogleOAuth(): Promise<OAuthResult> {
  let response: Awaited<ReturnType<typeof supabase.auth.signInWithOAuth>>;
  try {
    response = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: GOOGLE_REDIRECT_URI,
        skipBrowserRedirect: true,
      },
    });
  } catch {
    return {
      handled: true,
      success: false,
      message: 'Login Google gagal dimulai. Coba lagi nanti.',
    };
  }

  if (response.error || !response.data?.url) {
    return {
      handled: true,
      success: false,
      message: 'Login Google gagal dimulai. Coba lagi nanti.',
    };
  }

  let result: Awaited<ReturnType<typeof WebBrowser.openAuthSessionAsync>>;
  googleOAuthInProgress = true;
  try {
    result = await WebBrowser.openAuthSessionAsync(response.data.url, GOOGLE_REDIRECT_URI);
  } catch {
    googleOAuthInProgress = false;
    return { handled: true, success: false, message: 'Login Google gagal dibuka.' };
  }

  if (result.type === 'success') {
    try {
      return await handleAuthCallbackUrl(result.url, 'google');
    } finally {
      googleOAuthInProgress = false;
    }
  }
  googleOAuthInProgress = false;
  return { handled: true, success: false, message: 'Login Google dibatalkan.' };
}
