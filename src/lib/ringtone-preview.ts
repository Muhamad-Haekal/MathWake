let previewPlayer: import('expo-audio').AudioPlayer | null = null;
let previewGeneration = 0;

export async function previewRingtone(uri: string | number): Promise<void> {
  const generation = ++previewGeneration;
  stopRingtonePreview(false);
  try {
    const Audio = await import('expo-audio');
    await Audio.setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'doNotMix' });
    if (generation !== previewGeneration) return;
    const player = Audio.createAudioPlayer(uri);
    if (generation !== previewGeneration) {
      try { player.remove(); } catch {}
      return;
    }
    player.loop = true;
    player.volume = 1;
    previewPlayer = player;
    player.play();
  } catch {
    if (generation === previewGeneration) stopRingtonePreview(false);
  }
}

export function stopRingtonePreview(invalidate = true): void {
  if (invalidate) previewGeneration += 1;
  const player = previewPlayer;
  previewPlayer = null;
  if (!player) return;
  try { player.pause(); } catch {}
  try { player.remove(); } catch {}
}
