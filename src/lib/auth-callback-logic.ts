export type AuthCallbackKind = 'google' | 'recovery' | 'unknown';

export type AuthCallbackResult = {
  handled: boolean;
  success: boolean;
  kind: AuthCallbackKind;
  message?: string;
};

export type CallbackParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function classifyAuthCallbackParams(
  params: CallbackParams,
  expectedKind?: AuthCallbackKind,
): { action: 'exchange'; kind: AuthCallbackKind; code: string }
  | { action: 'failure'; result: AuthCallbackResult } {
  const code = firstParam(params.code);
  const explicitRecovery = firstParam(params.type)?.toLowerCase() === 'recovery'
    || !!firstParam(params.token)
    || !!firstParam(params.token_hash);

  if (code) {
    return {
      action: 'exchange',
      kind: explicitRecovery ? 'recovery' : expectedKind ?? 'unknown',
      code,
    };
  }

  if (explicitRecovery) {
    return {
      action: 'failure',
      result: {
        handled: true,
        success: false,
        kind: 'recovery',
        message: 'Format tautan pemulihan ini tidak didukung. Kembali ke reset password untuk meminta kode atau tautan baru.',
      },
    };
  }

  const error = firstParam(params.error);
  if (error && firstParam(params.state)) {
    const normalizedError = error.toLowerCase();
    return {
      action: 'failure',
      result: {
        handled: true,
        success: false,
        kind: 'google',
        message: normalizedError === 'access_denied'
          || normalizedError === 'user_cancelled'
          || normalizedError === 'cancelled'
          ? 'Login Google dibatalkan.'
          : 'Login Google gagal. Coba lagi nanti.',
      },
    };
  }

  return {
    action: 'failure',
    result: {
      handled: true,
      success: false,
      kind: expectedKind ?? 'unknown',
      message: expectedKind === 'google'
        ? 'Login Google tidak dapat diproses. Coba lagi nanti.'
        : 'Tautan autentikasi tidak dapat diproses atau sudah kedaluwarsa. Coba login atau mulai reset password lagi.',
    },
  };
}

export async function processAuthCallback(
  params: CallbackParams,
  expectedKind: AuthCallbackKind,
  exchangeCode: (code: string) => Promise<{ kind?: AuthCallbackKind; error?: unknown }>,
): Promise<AuthCallbackResult> {
  const action = classifyAuthCallbackParams(params, expectedKind);
  if (action.action === 'failure') return action.result;

  try {
    const exchange = await exchangeCode(action.code);
    if (exchange.error) {
      return {
        handled: true,
        success: false,
        kind: action.kind,
        message: action.kind === 'google'
          ? 'Login Google gagal. Coba lagi nanti.'
          : 'Tautan pemulihan tidak dapat diverifikasi atau sudah kedaluwarsa. Minta tautan baru.',
      };
    }
    return {
      handled: true,
      success: true,
      kind: exchange.kind ?? action.kind,
    };
  } catch {
    return {
      handled: true,
      success: false,
      kind: action.kind,
      message: action.kind === 'google'
        ? 'Login Google gagal. Coba lagi nanti.'
        : 'Tautan pemulihan tidak dapat diverifikasi atau sudah kedaluwarsa. Minta tautan baru.',
    };
  }
}

/** Deduplicates in-flight and recently completed URL processing without changing its result. */
export function createCallbackUrlProcessor<T, A = undefined>(
  process: (url: string, argument: A | undefined) => Promise<T>,
  maxCompleted = 16,
): (url: string, argument?: A) => Promise<T> {
  const pending = new Map<string, Promise<T>>();
  const completed = new Map<string, T>();

  return (url, argument) => {
    const cached = completed.get(url);
    if (cached !== undefined) return Promise.resolve(cached);

    const inFlight = pending.get(url);
    if (inFlight) return inFlight;

    const operation = process(url, argument).then((result) => {
      completed.set(url, result);
      while (completed.size > maxCompleted) {
        const oldestKey = completed.keys().next().value;
        if (oldestKey === undefined) break;
        completed.delete(oldestKey);
      }
      return result;
    }).finally(() => {
      pending.delete(url);
    });
    pending.set(url, operation);
    return operation;
  };
}
