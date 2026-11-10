export const PROFILE_DISPLAY_NAME_MAX_LENGTH = 80;
export const RECOVERY_PASSWORD_MIN_LENGTH = 6;

export function validateProfileDisplayName(displayName: string): string | null {
  const normalized = displayName.trim();
  if (!normalized || normalized.length > PROFILE_DISPLAY_NAME_MAX_LENGTH) {
    return 'Nama harus berisi 1 sampai 80 karakter.';
  }
  return null;
}

export function validateRecoveryPassword(password: string, confirmation: string): string | null {
  if (!password) return 'Password tidak boleh kosong.';
  if (password.length < RECOVERY_PASSWORD_MIN_LENGTH) return 'Password minimal 6 karakter.';
  if (!confirmation) return 'Konfirmasi password tidak boleh kosong.';
  if (password !== confirmation) return 'Password tidak cocok.';
  return null;
}
