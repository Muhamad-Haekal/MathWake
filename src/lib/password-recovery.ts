import AsyncStorage from '@react-native-async-storage/async-storage';

export { validateRecoveryPassword } from '@/lib/account-validation';

export const PASSWORD_RECOVERY_REDIRECT_URI = 'mathwake://auth/callback';
export const RECOVERY_MARKER_MAX_AGE_MS = 30 * 60 * 1000;

const RECOVERY_MARKER_KEY = 'mathwake:password-recovery';
let markerOperation: Promise<void> = Promise.resolve();
let markerGeneration = 0;

export type RecoveryMarker = {
  userId: string;
  verifiedAt: number;
  expiresAt: number;
};

export function normalizeRecoveryEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateRecoveryEmail(email: string): string | null {
  if (!email.trim()) return 'Email tidak boleh kosong.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Format email tidak valid.';
  return null;
}

export function validateRecoveryOtp(token: string): string | null {
  const normalized = token.replace(/\s/g, '');
  if (!normalized) return 'Kode OTP tidak boleh kosong.';
  if (!/^\d{4,12}$/.test(normalized)) return 'Masukkan kode OTP yang valid.';
  return null;
}

export function recoveryErrorMessage(message: string): string {
  const value = message.toLowerCase();
  if (value.includes('rate limit') || value.includes('too many requests') || value.includes('over_request')) {
    return 'Terlalu banyak percobaan. Tunggu sebentar lalu coba lagi.';
  }
  if (value.includes('network') || value.includes('fetch') || value.includes('failed to fetch')) {
    return 'Tidak dapat terhubung. Periksa koneksi internet kamu.';
  }
  if (value.includes('expired') || value.includes('invalid') || value.includes('otp') || value.includes('token')) {
    return 'Kode OTP salah atau sudah kedaluwarsa. Minta kode baru lalu coba lagi.';
  }
  if (value.includes('password') || value.includes('weak')) {
    return 'Password terlalu pendek atau terlalu lemah. Gunakan minimal 6 karakter.';
  }
  return 'Terjadi kesalahan. Coba lagi nanti.';
}

export function isRecoveryMarkerValid(
  marker: RecoveryMarker | null,
  userId: string | undefined,
  sessionExpiresAtMs: number | undefined,
  now = Date.now(),
): marker is RecoveryMarker {
  return !!marker
    && !!userId
    && marker.userId === userId
    && marker.verifiedAt <= now
    && marker.expiresAt > now
    && (!sessionExpiresAtMs || sessionExpiresAtMs > now);
}

export async function saveRecoveryMarker(userId: string, now = Date.now()): Promise<void> {
  const generation = ++markerGeneration;
  const marker: RecoveryMarker = {
    userId,
    verifiedAt: now,
    expiresAt: now + RECOVERY_MARKER_MAX_AGE_MS,
  };
  markerOperation = markerOperation.catch(() => undefined).then(async () => {
    if (generation !== markerGeneration) return;
    await AsyncStorage.setItem(RECOVERY_MARKER_KEY, JSON.stringify(marker));
  });
  await markerOperation;
}

export async function loadRecoveryMarker(): Promise<RecoveryMarker | null> {
  try {
    const raw = await AsyncStorage.getItem(RECOVERY_MARKER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RecoveryMarker>;
    if (
      typeof parsed.userId !== 'string'
      || typeof parsed.verifiedAt !== 'number'
      || typeof parsed.expiresAt !== 'number'
    ) return null;
    return parsed as RecoveryMarker;
  } catch {
    return null;
  }
}

export async function clearRecoveryMarker(): Promise<void> {
  const generation = ++markerGeneration;
  markerOperation = markerOperation.catch(() => undefined).then(async () => {
    if (generation !== markerGeneration) return;
    await AsyncStorage.removeItem(RECOVERY_MARKER_KEY);
  });
  await markerOperation;
}
