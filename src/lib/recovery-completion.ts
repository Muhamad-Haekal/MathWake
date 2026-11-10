export type LocalSessionStatus = 'signed-out' | 'signed-in' | 'unknown';

export type RecoveryCompletion = {
  nextStep: 'login' | 'retry-sign-out';
  message: string;
};

export function recoveryCompletionAfterUpdate({
  signOutError,
  localSessionStatus,
  recoveryMarkerCleared,
}: {
  signOutError: boolean;
  localSessionStatus: LocalSessionStatus;
  recoveryMarkerCleared: boolean;
}): RecoveryCompletion {
  if (localSessionStatus === 'signed-in') {
    return {
      nextStep: 'retry-sign-out',
      message: 'Password berhasil diperbarui, tetapi sesi di perangkat ini masih aktif. Tutup sesi sebelum masuk kembali.',
    };
  }

  if (localSessionStatus === 'unknown') {
    return {
      nextStep: 'retry-sign-out',
      message: 'Password berhasil diperbarui, tetapi status sesi di perangkat ini belum dapat dipastikan. Coba tutup sesi lagi sebelum melanjutkan.',
    };
  }

  const warnings = [
    signOutError ? 'Supabase melaporkan masalah saat sign-out; sesi lain mungkin masih aktif.' : '',
    recoveryMarkerCleared ? '' : 'Pembersihan state recovery lokal belum dapat dikonfirmasi.',
  ].filter(Boolean);

  return {
    nextStep: 'login',
    message: [
      'Password berhasil diperbarui. Sesi lokal di perangkat ini sudah tidak aktif.',
      ...warnings,
    ].join(' '),
  };
}
