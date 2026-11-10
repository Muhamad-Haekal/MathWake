import { Platform } from 'react-native';

import {
  getNativeDefaultAlarmRingtoneUri,
  getNativeActiveAlarmEvent,
  getNativeAlarmEvent,
  isNativeRingPlaying,
  muteNativeRing,
  stopNativeRing,
} from './alarm-native';
import { MATHWAKE_ALARM_SOUND } from './alarm-sound';
import { getAlarmRingtone } from './alarm-ringtones';

// ---------------------------------------------------------------------------
// Persistent Alarm Audio Engine
//
// Manages a looping audio alarm that survives component unmounts, challenge
// retries, and background transitions. Uses expo-audio with a media playback
// foreground service so audio continues while the screen is locked or the app
// is in the background (Android).
//
// How an alarm actually rings (Android OS level → JS level):
//
//   At fire time the native MathWakeAlarmReceiver starts AlarmRingerService, a
//   foreground service that loops the alarm sound immediately — even while the
//   device is locked or the app is killed. No notification tap required.
//
//   When the app runs, startAlarmAudio() keeps the native loop as the owner
//   while it is audibly ringing. expo-audio is used only when the native loop
//   is unavailable or has failed. On valid success stopAlarmAudio() stops
//   BOTH the expo-audio loop (when present) and the OS service.
//
// Design:
// - One AudioPlayer instance per occurrence, keyed by eventId.
//
// Lifecycle:
//   OS fires alarm (native exact engine)
//     → AlarmRingerService loops the sound without any interaction
//     → full-screen intent launches the app into /challenge (or the user taps)
//     → challenge mount effect calls startAlarmAudio → native loop remains owner
//       (or expo-audio is used only as a native-unavailable fallback)
//   Challenge retry (failed): audio keeps playing — nothing calls stop
//   Challenge passed: stopAlarmAudio(alarmId) is called (JS + native)
//   Closing /challenge screen: audio keeps playing — nothing calls stop
//
// Android background audio requirements (handled by expo-audio config plugin):
//   - FOREGROUND_SERVICE + FOREGROUND_SERVICE_MEDIA_PLAYBACK permissions
//   - AudioControlsService declared in AndroidManifest (automatic via plugin)
//   - setActiveForLockScreen() must be called for sustained background play
//     (without it Android kills the service after ~3 minutes)
//
// Limitations (documented, not claimed as solved):
//   - Audio stops if the user force-stops the app (Android OS guarantee:
//     no app can survive a force-stop).
//   - OEM battery optimisers (Xiaomi, Huawei, Samsung) may kill the
//     foreground service; user must whitelist the app in device settings.
//   - This module is a no-op on web (expo-audio is not supported there).
//   - iOS background audio is handled differently (AVAudioSession);
//     this module works on iOS via expo-audio but lock-screen behaviour
//     has not been verified on physical iOS hardware.
// ---------------------------------------------------------------------------

// Alarm sound asset, relative require so Metro resolves it with or without
// the tsconfig `@/assets` alias. The WAV in assets/audio/alarm.wav is a
// generated 15 s two-tone alarm (880/1176 Hz beeps); it doubles as the OS
// notification sound (same file registered in app.json), so it must stay
// long enough to be meaningful before the user taps, and loop-cleanly for
// the in-app player (starts/ends in silence).
type AlarmAudioSource = number | string;

async function resolveAlarmAudioSource(alarmId: string): Promise<AlarmAudioSource> {
  const ringtone = await getAlarmRingtone(alarmId);
  if (ringtone.kind === 'mathwake') return MATHWAKE_ALARM_SOUND;
  if (ringtone.kind === 'custom' && ringtone.uri) return ringtone.uri;
  if (ringtone.kind === 'system') {
    const uri = await getNativeDefaultAlarmRingtoneUri();
    if (uri) return uri;
    throw new Error('system-ringtone-uri-unavailable');
  }
  throw new Error('alarm-ringtone-source-unavailable');
}

async function waitForPlaybackStart(
  player: import('expo-audio').AudioPlayer,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      subscription.remove();
      clearTimeout(timeout);
      if (error) reject(error); else resolve();
    };
    const subscription = player.addListener('playbackStatusUpdate', (status) => {
      if (status.error) finish(new Error('alarm-audio-playback-error'));
      else if (status.playing) finish();
    });
    const timeout = setTimeout(() => finish(new Error('alarm-audio-start-timeout')), 3000);
  });
}

// Module-level map: alarmId → AudioPlayer instance.
// AudioPlayer created with createAudioPlayer() lives independently of any
// React component lifecycle.
//
// `startingIds` closes a race: startAlarmAudio awaits (dynamic import, audio
// mode) between the already-playing check and the map insert. Two concurrent
// starters (e.g. notification tap handler + challenge mount effect, or
// auto-start listener + pending-alarm consumer) would both pass the check and
// create two players; the map would keep only the last one, leaking the first
// as an unstoppable ghost loop. The reservation is added synchronously —
// before the first await — so concurrent calls serialize correctly on the
// single JS thread. Released in `finally`, so a failed start stays retryable.
const activePlayers = new Map<string, import('expo-audio').AudioPlayer>();
const startingIds = new Set<string>();
const generations = new Map<string, string>();
/** Must stay well below AlarmRingerService.MUTE_LEASE_MS (30 s). */
const MUTE_LEASE_RENEW_MS = 5000;

/**
 * Start the looping alarm audio for the given alarmId.
 * If audio is already playing for this alarmId, this is a no-op.
 * Safe to call from a notification listener (outside React).
 */
export async function startAlarmAudio(alarmId: string, eventId: string = alarmId, generation = ''): Promise<void> {
  if (Platform.OS === 'web') return;
  if (!eventId || activePlayers.has(eventId) || startingIds.has(eventId)) return;
  startingIds.add(eventId);
  let player: import('expo-audio').AudioPlayer | null = null;

  try {
    // A challenge can remain mounted after a native Snooze or stop action.
    // Do not let its AppState recovery path restart JS audio for an event that
    // is no longer the live RINGING occurrence. Expo fallback events have no
    // native ledger row and continue through the existing fallback path.
    if (generation) {
      const nativeEvent = await getNativeAlarmEvent(eventId);
      if (nativeEvent && (
        nativeEvent.alarmId !== alarmId || nativeEvent.generation !== generation || nativeEvent.state !== 'ringing'
      )) {
        console.info('[MathWake][AlarmAudio] stale native occurrence ignored:', { alarmId, eventId });
        return;
      }
    }

    // Prefer the native ringer. Its STREAM_ALARM volume is managed by
    // AlarmRingerService, and it can continue while the challenge is mounted,
    // backgrounded, or the screen is locked.
    const activeNative = await getNativeActiveAlarmEvent();
    // A queued successor may take native ownership before a stale JS player
    // receives its own completion callback. Release only the old JS player;
    // exact native stop calls remain occurrence-scoped below.
    for (const staleEventId of activePlayers.keys()) {
      if (staleEventId !== eventId && staleEventId !== activeNative?.eventId) {
        stopAlarmAudio('', staleEventId, generations.get(staleEventId) ?? '');
      }
    }
    if (activeNative && (activeNative.eventId !== eventId || activeNative.generation !== generation)) return;
    if (generation && await isNativeRingPlaying(eventId, generation)) {
      console.info('[MathWake][AlarmAudio] native ringer retained:', alarmId);
      return;
    }

    let Audio: typeof import('expo-audio');
    try {
      Audio = await import('expo-audio');
    } catch (e) {
      console.warn('[MathWake][AlarmAudio] expo-audio unavailable:', {
        message: e instanceof Error ? e.message : 'unknown',
      });
      return;
    }

    // Configure audio session: alarm volume stream, continue in background.
    await Audio.setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    });

    // Use maximum player gain. The native owner separately controls
    // STREAM_ALARM; this JS path remains a fallback when native is unavailable.

    const source = await resolveAlarmAudioSource(alarmId);
    console.info('[MathWakeRingtoneTrace] js-source', {
      alarmId,
      scheme: typeof source === 'string' ? source.split(':', 1)[0] : 'asset',
    });

    // Native may have finished preparing while the JS fallback resolved its
    // source. Re-check before creating a second player.
    if (generation && await isNativeRingPlaying(eventId, generation)) {
      console.info('[MathWake][AlarmAudio] native ringer started during fallback setup:', alarmId);
      return;
    }

    // createAudioPlayer survives component unmounts.
    player = Audio.createAudioPlayer(source);
    player.loop = true;
    player.volume = 1;

    // Listen for unexpected playback stops (interruptions, audio errors,
    // phone calls). If audio stops while the player is still in activePlayers,
    // remove the stale entry so startAlarmAudio can restart it on retry.
    //
    // This lease path is used only when JS is the fallback owner. Renew it
    // only from real "playing" status events of THIS player.
    let lastLeaseRenewAt = 0;
    const createdPlayer = player;
    player.addListener('playbackStatusUpdate', (status) => {
      if (status.error) {
        console.warn('[MathWake][AlarmAudio] player error, clearing stale entry:', {
          alarmId,
          error: status.error,
        });
        if (activePlayers.get(eventId) === createdPlayer) activePlayers.delete(eventId);
        return;
      }
      if (!status.playing || activePlayers.get(eventId) !== createdPlayer) return;
      const nowMs = Date.now();
      if (nowMs - lastLeaseRenewAt < MUTE_LEASE_RENEW_MS) return;
      lastLeaseRenewAt = nowMs;
      if (generation) void muteNativeRing(eventId, generation);
    });

    // Configure audio session first, then enable lock screen, then play.
    // setActiveForLockScreen requires interruptionMode: 'doNotMix' (already
    // set above in setAudioModeAsync) or the OS may not associate the controls
    // with this player.
    player.setActiveForLockScreen(true, {
      title: 'Alarm MathWake',
      artist: 'Selesaikan tantangan matematika untuk mematikan alarm',
    });

    // Last race check: do not start JS if the native ringer became audible
    // while the fallback player was being prepared.
    if (generation && await isNativeRingPlaying(eventId, generation)) {
      try { player.setActiveForLockScreen(false); } catch { /* best effort */ }
      try { player.remove(); } catch { /* best effort */ }
      player = null;
      console.info('[MathWake][AlarmAudio] native ringer won playback race:', alarmId);
      return;
    }

    player.play();
    await waitForPlaybackStart(player);

    // The native service can become audible while JS is starting. Prefer it
    // if that happens, and tear down the fallback player before it can remain
    // as a second source.
    if (generation && await isNativeRingPlaying(eventId, generation)) {
      try { player.pause(); } catch { /* best effort */ }
      try { player.setActiveForLockScreen(false); } catch { /* best effort */ }
      try { player.remove(); } catch { /* best effort */ }
      player = null;
      console.info('[MathWake][AlarmAudio] native ringer won after JS start:', alarmId);
      return;
    }

    activePlayers.set(eventId, player);
    generations.set(eventId, generation);
    // In the fallback path only, mute native after JS is confirmed playing so
    // a failed fallback never leaves the alarm silent.
    if (generation) await muteNativeRing(eventId, generation);

    console.info('[MathWake][AlarmAudio] started for alarm:', alarmId);
  } catch (e) {
    if (player && !activePlayers.has(eventId)) {
      try { player.remove(); } catch { /* best effort; native ringer remains active */ }
    }
    console.warn('[MathWake][AlarmAudio] failed to start:', {
      alarmId,
      message: e instanceof Error ? e.message : 'unknown',
    });
  } finally {
    startingIds.delete(eventId);
  }
}

/**
 * Stop and release the alarm audio for the given alarmId.
 * No-op if nothing is playing for this alarmId.
 * Call only after a successful challenge completion.
 *
 * Robustness matters here more than ordering elegance: a previous version
 * ran setActiveForLockScreen(false) → pause() → remove() inside ONE try, so
 * a throw in the first call skipped pause()/remove() while `finally` still
 * dropped the map entry — orphaning a player that could never be stopped
 * (and that a later mount would duplicate). Every step below is
 * individually guarded, the entry is removed FIRST so a concurrent starter
 * can re-arm if genuinely needed, and pause() comes before remove().
 */
export function stopAlarmAudio(alarmId: string, eventId: string = alarmId, generation = ''): void {
  // Full teardown on the native side too: silence the OS-level ringer and
  // remove its sticky notification. Fire-and-forget — never blocks the JS
  // player teardown, never throws.
  if (generation) void stopNativeRing(eventId, generation);

  const player = activePlayers.get(eventId);
  if (!player) return;
  activePlayers.delete(eventId);
  generations.delete(eventId);

  try {
    player.pause();
  } catch (e) {
    console.warn('[MathWake][AlarmAudio] error pausing player:', {
      alarmId,
      message: e instanceof Error ? e.message : 'unknown',
    });
  }
  try {
    player.remove();
  } catch (e) {
    console.warn('[MathWake][AlarmAudio] error removing player:', {
      alarmId,
      message: e instanceof Error ? e.message : 'unknown',
    });
  }
  try {
    // Release lock-screen controls / foreground-service binding last: after
    // remove() this call may throw on some OS versions, which must not mask
    // the pause + remove above.
    player.setActiveForLockScreen(false);
  } catch (e) {
    console.warn('[MathWake][AlarmAudio] error releasing lock-screen controls:', {
      alarmId,
      message: e instanceof Error ? e.message : 'unknown',
    });
  }
  console.info('[MathWake][AlarmAudio] stopped for alarm:', alarmId);
}

/**
 * Returns true if alarm audio is currently playing for the given alarmId.
 * Does not start or stop audio.
 */
export function isAlarmAudioPlaying(alarmId: string, eventId: string = alarmId): boolean {
  return activePlayers.has(eventId);
}

/**
 * Stop all active alarm audio players.
 * Use only in exceptional cleanup scenarios (e.g. sign-out).
 */
export function stopAllAlarmAudio(): void {
  for (const [eventId] of activePlayers) {
    stopAlarmAudio('', eventId, generations.get(eventId) ?? '');
  }
}
