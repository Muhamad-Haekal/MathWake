package expo.modules.mathwakealarm

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

// ---------------------------------------------------------------------------
// AlarmRingerService — persistent, looping alarm audio owned by the OS.
//
// WHY THIS EXISTS (Phase 1, Core Alarm Reliability):
//   A BroadcastReceiver cannot play audio for more than the OS notification
//   sound. When the app is backgrounded or killed, no JS runs, so the previous
//   design only produced a ~2-3 s notification chime and then silence until
//   the user tapped. This service is started directly by the alarm receiver at
//   fire time and loops the bundled alarm sound on the ALARM audio stream with
//   a mediaPlayback foreground service, so the alarm rings continuously on the
//   lock screen and in the background without any user interaction.
//
// LIFECYCLE:
//   receiver fires → startRinger() → onStartCommand → startForeground(ring
//   notification) → looping MediaPlayer. The JS layer later takes over:
//     - muteRing(alarmId): pause audio, KEEP the sticky notification (the app
//       is now in the foreground and expo-audio owns playback).
//     - stopRing(alarmId): full silence — release audio, remove notification,
//       stop the service (valid success or explicit cancel).
//
// ANDROID CONSTRAINTS (documented, not claimed as solved):
//   - Starting a foreground service from the background is restricted since
//     Android 12, EXCEPT for exact alarms; this service is only ever started
//     from the setAlarmClock receiver, which is an exempt path.
//   - Android 13+ needs POST_NOTIFICATIONS for the notification to be visible;
//     Android 14+ needs FOREGROUND_SERVICE_MEDIA_PLAYBACK and the service type.
//   - A user force-stop or OEM battery optimiser can still kill the process;
//     no app can survive a force-stop.
// ---------------------------------------------------------------------------

class AlarmRingerService : Service() {
  private var player: MediaPlayer? = null
  private var playerOwner: RingerOwnership? = null
  private var resourceOwner: RingerOwnership? = null
  private var resourceStartId: Int = 0
  private var wakeLock: PowerManager.WakeLock? = null
  private var wakeLockOwner: RingerOwnership? = null
  private var audioManager: AudioManager? = null
  private var audioFocusOwner: RingerOwnership? = null
  private var audioFocusListener: AudioManager.OnAudioFocusChangeListener? = null
  private var activeDeepLink: String = ""
  private var activeDeepLinkOwner: RingerOwnership? = null
  private var alarmVolumeBefore: Int? = null
  private var alarmVolumeRaisedTo: Int? = null
  private var alarmVolumeOwner: RingerOwnership? = null

  /** True after the JS layer has taken over playback: audio stays paused. */
  @Volatile
  private var muted = false
  private var muteOwner: RingerOwnership? = null
  private var muteHandler: Handler? = null
  private var muteLeaseRunnable: Runnable? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    muted = false
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val alarmId = intent?.getStringExtra(EXTRA_ALARM_ID)
    val eventId = intent?.getStringExtra(EXTRA_EVENT_ID)
    val generation = intent?.getStringExtra(EXTRA_EVENT_GENERATION)
    val triggerAtMs = intent?.getLongExtra(EXTRA_OCCURRENCE_TRIGGER, 0L) ?: 0L
    if (alarmId.isNullOrBlank() || eventId.isNullOrBlank() || generation.isNullOrBlank() || triggerAtMs <= 0L) {
      Log.w(TAG, "service start rejected reason=missing-event-identity")
      stopIfIdle(startId)
      return START_NOT_STICKY
    }
    if (AlarmEventLedger.eventId(alarmId, triggerAtMs, generation) != eventId) {
      Log.w(TAG, "service start rejected reason=event-identity-mismatch alarmId=$alarmId")
      stopIfIdle(startId)
      return START_NOT_STICKY
    }
    val storedEvent = AlarmEventLedger.get(sharedAlarmEventStore(prefs(applicationContext)), eventId)
    if (storedEvent == null || storedEvent.alarmId != alarmId || storedEvent.generation != generation ||
      storedEvent.triggerAtMs != triggerAtMs || storedEvent.state != AlarmEventState.RINGING
    ) {
      Log.w(TAG, "service start rejected reason=event-not-ringing alarmId=$alarmId")
      stopIfIdle(startId)
      return START_NOT_STICKY
    }
    val currentOwner = ownership.current()
    if (currentOwner?.eventId == eventId && currentOwner.generation == generation && resourceOwner == ownerFor(eventId, generation)) {
      return START_NOT_STICKY
    }
    if (currentOwner != null && (currentOwner.eventId != eventId || currentOwner.generation != generation)) {
      // Queue ownership is reserved before a start intent is sent. A different
      // event must never replace resources held by the current occurrence.
      Log.i(TAG, "queued event start ignored while owner active eventId=$eventId")
      return START_NOT_STICKY
    }
    val deepLink = intent?.getStringExtra(EXTRA_DEEP_LINK) ?: ""
    val record = readRecord(prefs(applicationContext), alarmId)
      ?.takeIf { it.triggerAtMs == triggerAtMs }
      ?: AlarmRecord(alarmId, triggerAtMs, deepLink, "", emptySet(), false)
    try {
      ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        buildRingNotification(this, record, eventId, generation),
        foregroundServiceType(),
      )
    } catch (e: Exception) {
      Log.w("MathWakeRinger", "service stopped reason=foreground-start-failed alarmId=$alarmId exception=${e.javaClass.simpleName}")
      failReservedEvent(eventId, generation)
      stopIfIdle(startId)
      return START_NOT_STICKY
    }
    val previousOwner = resourceOwner
    val owner = ownership.claim(alarmId, eventId, generation)
    ownership.runIfCurrent(owner) {
      if (previousOwner != null && previousOwner != owner) stopRingingInternal(previousOwner)
      activeDeepLink = deepLink
      activeDeepLinkOwner = owner
      resourceOwner = owner
      resourceStartId = startId
      acquireWakeLock(owner)
      startLoopingPlayer(owner, intent?.getStringExtra(EXTRA_RINGTONE_URI), deepLink)
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    val departingOwner = resourceOwner
    Log.i("MathWakeRinger", "service stopped reason=onDestroy alarmId=${activeAlarmId ?: "none"}")
    resourceOwner?.let { owner ->
      ownership.runIfCurrent(owner) {
        stopRingingInternal(owner)
        ownership.release(owner)
      }
    }
    if (instance === this) instance = null
    super.onDestroy()
    departingOwner?.let { owner ->
      val store = sharedAlarmEventStore(prefs(applicationContext))
      val event = AlarmEventLedger.get(store, owner.eventId)
      if (event?.state == AlarmEventState.RINGING) {
        AlarmEventLedger.transition(store, owner.eventId, owner.generation, AlarmEventState.QUEUED)
      }
    }
    pumpAlarmQueue(applicationContext)
  }

  private fun postFallbackNotification(alarmId: String, deepLink: String, ringtoneUri: String? = null) {
    try {
      fallbackNotify(
        applicationContext,
        AlarmRecord(
          alarmId,
          0L,
          deepLink,
          "",
          emptySet(),
          false,
          ringtoneUri ?: "android-resource://alarm",
        ),
      )
    } catch (fallbackError: Exception) {
      Log.w(TAG, "fallback notification failed: ${fallbackError.message}")
    }
  }

  private fun stopIfIdle(startId: Int) {
    if (resourceOwner == null) stopSelf(startId)
  }

  private fun stopOwned(owner: RingerOwnership) {
    if (resourceOwner != owner) return
    val ownedStartId = resourceStartId
    if (ownedStartId > 0) stopSelf(ownedStartId)
  }

  /** JS handoff: stop the OS loop but keep the sticky notification visible. */
  private fun muteInternal(owner: RingerOwnership) {
    if (resourceOwner != owner || playerOwner != owner) return
    val event = AlarmEventLedger.get(sharedAlarmEventStore(prefs(applicationContext)), owner.eventId)
    if (event?.generation != owner.generation || event.state != AlarmEventState.RINGING) return
    Log.i("MathWakeRinger", "service muted reason=js-handoff alarmId=${owner.alarmId}")
    muted = true
    muteOwner = owner
    pausePlayback(owner)
    releaseWakeLock(owner)
    // The handoff is a lease, not a permanent silence: the JS player renews it
    // while it is actually looping. If JS dies (process killed, player error,
    // audio interruption) the renewals stop and the OS loop resumes, so a
    // failed handoff can never leave an unsolved alarm silent.
    armMuteLease(owner)
  }

  private fun armMuteLease(owner: RingerOwnership) {
    val handler = Handler(Looper.getMainLooper())
    muteHandler = handler
    muteLeaseRunnable?.let { handler.removeCallbacks(it) }
    val runnable = Runnable {
      ownership.runIfCurrent(owner) {
        if (resourceOwner != owner || muteOwner != owner || !muted) return@runIfCurrent
        Log.i("MathWakeRinger", "mute lease expired; resuming ringer alarmId=${owner.alarmId}")
        muted = false
        muteOwner = null
        resumePlayback(owner)
      }
    }
    muteLeaseRunnable = runnable
    handler.postDelayed(runnable, MUTE_LEASE_MS)
  }

  private fun cancelMuteLease() {
    val runnable = muteLeaseRunnable ?: return
    muteHandler?.removeCallbacks(runnable)
    muteLeaseRunnable = null
  }

  private fun readRingtoneUri(alarmId: String, intentUri: String?): String {
    if (!intentUri.isNullOrBlank()) return intentUri
    return readRecord(prefs(applicationContext), alarmId)?.ringtoneUri ?: "android-resource://alarm"
  }

  private fun startLoopingPlayer(owner: RingerOwnership, intentUri: String?, deepLink: String) {
    val alarmId = owner.alarmId
    try {
      Log.i(TAG, "starting ringer alarmId=$alarmId")
      val selectedUri = readRingtoneUri(alarmId, intentUri)
      Log.i("MathWakeRingtoneTrace", "service alarmId=$alarmId scheme=${Uri.parse(selectedUri).scheme ?: "none"} source=${if (intentUri.isNullOrBlank()) "record" else "intent"}")
      Log.i(TAG, "using ringtone scheme=${Uri.parse(selectedUri).scheme ?: "none"}")
      val mp = MediaPlayer().apply {
        // ALARM stream: respects the user's alarm volume and is routed like a
        // system alarm, not like media/notifications.
        setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build(),
        )
        isLooping = true
        setVolume(1f, 1f)
        setDataSource(this@AlarmRingerService, alarmSoundUri(this@AlarmRingerService, selectedUri))
        setOnPreparedListener { preparedPlayer ->
          ownership.runIfCurrent(owner) {
            if (resourceOwner == owner && playerOwner == owner && player === preparedPlayer && !muted) {
              raiseAlarmVolumeForPlayback(owner)
              preparedPlayer.start()
            }
          }
        }
        setOnErrorListener { _, what, extra ->
          ownership.runIfCurrent(owner) {
            if (resourceOwner == owner && playerOwner == owner) {
              Log.w("MathWakeRinger", "service stopped reason=media-player-error alarmId=$alarmId what=$what extra=$extra")
              failEvent(owner)
              val ownedStartId = resourceStartId
              stopRingingInternal(owner)
              if (ownedStartId > 0) stopSelf(ownedStartId)
            }
          }
          true
        }
      }
      player = mp
      playerOwner = owner
      requestAudioFocus(owner)
      mp.prepareAsync()
      // Covers the edge where the JS layer muted us before playback began.
      if (muted && muteOwner == owner) pausePlayback(owner)
    } catch (e: Exception) {
      ownership.runIfCurrent(owner) {
        if (resourceOwner == owner) {
          Log.w("MathWakeRinger", "service stopped reason=player-start-failed alarmId=$alarmId exception=${e.javaClass.simpleName}")
          failEvent(owner)
          val ownedStartId = resourceStartId
          stopRingingInternal(owner)
          if (ownedStartId > 0) stopSelf(ownedStartId)
        }
      }
    }
  }

  private fun stopRingingInternal(owner: RingerOwnership) {
    if (resourceOwner != owner) return
    resourceOwner = null
    resourceStartId = 0
    if (muteOwner == owner) {
      cancelMuteLease()
      muteOwner = null
      muted = false
    }
    releasePlayer(owner)
    abandonAudioFocus(owner)
    releaseWakeLock(owner)
    restoreAlarmVolumeIfOwned(owner)
    ownership.release(owner)
    if (activeDeepLinkOwner == owner) {
      activeDeepLinkOwner = null
      activeDeepLink = ""
    }
  }

  private fun failEvent(owner: RingerOwnership) {
    AlarmEventLedger.transition(
      sharedAlarmEventStore(prefs(applicationContext)), owner.eventId, owner.generation, AlarmEventState.FAILED,
    )
  }

  private fun releasePlayer(owner: RingerOwnership) {
    if (playerOwner != owner) return
    val mp = player
    player = null
    playerOwner = null
    if (mp != null) {
      try {
        if (mp.isPlaying) mp.stop()
      } catch (_: Exception) {
      }
      try {
        mp.release()
      } catch (_: Exception) {
      }
    }
  }

  private fun pausePlayback(owner: RingerOwnership) {
    if (playerOwner != owner) return
    try {
      if (player?.isPlaying == true) player?.pause()
    } catch (e: Exception) {
      Log.w(TAG, "pause failed: ${e.message}")
    }
  }

  private fun resumePlayback(owner: RingerOwnership) {
    if (muted || resourceOwner != owner || playerOwner != owner) return
    try {
      val mp = player ?: return
      if (!mp.isPlaying) {
        acquireWakeLock(owner)
        raiseAlarmVolumeForPlayback(owner)
        mp.start()
      }
    } catch (e: Exception) {
      Log.w(TAG, "resume failed: ${e.message}")
    }
  }

  /** Raises only the alarm stream for this service's active playback. */
  private fun raiseAlarmVolumeForPlayback(owner: RingerOwnership) {
    if (alarmVolumeBefore != null) return
    try {
      val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
      if (am.isVolumeFixed) {
        Log.i(TAG, "alarm volume unchanged reason=device-volume-fixed")
        return
      }
      val current = am.getStreamVolume(AudioManager.STREAM_ALARM)
      val maximum = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
      if (maximum <= 0) {
        Log.w(TAG, "alarm volume unchanged reason=invalid-stream-maximum")
        return
      }
      alarmVolumeBefore = current
      alarmVolumeRaisedTo = maximum
      alarmVolumeOwner = owner
      if (current < maximum) {
        am.setStreamVolume(AudioManager.STREAM_ALARM, maximum, 0)
      }
      Log.i(TAG, "alarm volume prepared previous=$current maximum=$maximum applied=${am.getStreamVolume(AudioManager.STREAM_ALARM)}")
    } catch (e: Exception) {
      Log.w(TAG, "alarm volume change refused: ${e.message}")
    }
  }

  /** Restores only while the stream still has the value this service applied. */
  private fun restoreAlarmVolumeIfOwned(owner: RingerOwnership) {
    if (alarmVolumeOwner != owner) return
    val previous = alarmVolumeBefore ?: return
    val raisedTo = alarmVolumeRaisedTo
    alarmVolumeBefore = null
    alarmVolumeRaisedTo = null
    alarmVolumeOwner = null
    if (raisedTo == null) return
    try {
      val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val current = am.getStreamVolume(AudioManager.STREAM_ALARM)
      if (current == raisedTo) {
        am.setStreamVolume(AudioManager.STREAM_ALARM, previous, 0)
        Log.i(TAG, "alarm volume restored previous=$previous")
      } else {
        Log.i(TAG, "alarm volume restore skipped reason=volume-changed current=$current applied=$raisedTo")
      }
    } catch (e: Exception) {
      Log.w(TAG, "alarm volume restore refused: ${e.message}")
    }
  }

  @Suppress("DEPRECATION")
  private fun requestAudioFocus(owner: RingerOwnership) {
    try {
      val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
      audioManager = am
      val listener = AudioManager.OnAudioFocusChangeListener { change ->
        ownership.runIfCurrent(owner) {
          if (resourceOwner != owner || audioFocusOwner != owner) return@runIfCurrent
          when (change) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> pausePlayback(owner)
            AudioManager.AUDIOFOCUS_GAIN -> resumePlayback(owner)
          }
        }
      }
      audioFocusOwner = owner
      audioFocusListener = listener
      am.requestAudioFocus(
        listener,
        AudioManager.STREAM_ALARM,
        AudioManager.AUDIOFOCUS_GAIN,
      )
    } catch (e: Exception) {
      Log.w(TAG, "requestAudioFocus failed: ${e.message}")
    }
  }

  @Suppress("DEPRECATION")
  private fun abandonAudioFocus(owner: RingerOwnership) {
    if (audioFocusOwner != owner) return
    try {
      audioFocusListener?.let { audioManager?.abandonAudioFocus(it) }
    } catch (_: Exception) {
    }
    audioFocusOwner = null
    audioFocusListener = null
    audioManager = null
  }

  private fun acquireWakeLock(owner: RingerOwnership) {
    if (wakeLockOwner == owner && wakeLock?.isHeld == true) return
    if (wakeLockOwner != null && wakeLockOwner != owner) return
    try {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG).apply {
        setReferenceCounted(false)
        acquire()
      }
      wakeLock = wl
      wakeLockOwner = owner
    } catch (e: Exception) {
      Log.w(TAG, "acquireWakeLock failed: ${e.message}")
    }
  }

  private fun releaseWakeLock(owner: RingerOwnership) {
    if (wakeLockOwner != owner) return
    try {
      if (wakeLock?.isHeld == true) wakeLock?.release()
    } catch (_: Exception) {
    }
    wakeLock = null
    wakeLockOwner = null
  }

  companion object {
    private const val TAG = "MathWakeRinger"
    private const val WAKELOCK_TAG = "MathWake:AlarmRinger"
    /** JS must renew muteRing within this window or the OS loop resumes. */
    private const val MUTE_LEASE_MS = 30_000L
    private val ownership = RingerOwnershipCoordinator()
    private val queueStartLock = Any()

    @Volatile
    private var instance: AlarmRingerService? = null

    /** alarmId currently owned by the ringer service, or null when idle. */
    val activeAlarmId: String? get() = ownership.current()?.alarmId

    /**
     * Starts the looping ringer for [record]. Returns false when the OS refused
     * to start the foreground service so the caller can fall back to a
     * notification-sound alert. Never throws.
     */
    internal fun startRinger(context: Context, record: AlarmRecord): Boolean {
      val generation = record.eventGeneration ?: return false
      val eventId = AlarmEventLedger.eventId(record.alarmId, record.triggerAtMs, generation)
      val current = ownership.current()
    if (current?.eventId == eventId && current.generation == generation &&
      instance?.resourceOwner == current && instance?.player != null
    ) return true
      return try {
        val intent = Intent(context, AlarmRingerService::class.java).apply {
          putExtra(EXTRA_ALARM_ID, record.alarmId)
          putExtra(EXTRA_EVENT_ID, eventId)
          putExtra(EXTRA_OCCURRENCE_TRIGGER, record.triggerAtMs)
          putExtra(EXTRA_EVENT_GENERATION, generation)
          putExtra(EXTRA_DEEP_LINK, record.deepLink)
          putExtra(EXTRA_RINGTONE_URI, record.ringtoneUri)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        true
      } catch (e: Exception) {
        Log.w(TAG, "startRinger failed: ${e.message}")
        false
      }
    }

    /** Queue one valid occurrence and reserve the next FIFO event if idle. */
    internal fun enqueueAndPump(context: Context, event: AlarmEvent) {
      val store = sharedAlarmEventStore(prefs(context))
      AlarmEventQueue.enqueue(store, event) ?: return
      pumpAlarmQueue(context)
    }

    /** Restores queue records after process/boot recovery, then starts one owner. */
    internal fun restoreAndPump(context: Context) {
      pumpAlarmQueue(context)
    }

    internal fun pumpAlarmQueue(context: Context) {
      synchronized(queueStartLock) {
        if (ownership.current() != null) return
        val store = sharedAlarmEventStore(prefs(context))
        val next = AlarmEventQueue.recoverAndClaimNext(store, System.currentTimeMillis()) ?: return
        val owner = ownership.claim(next.alarmId, next.eventId, next.generation)
        startClaimedEvent(context, next, owner)
      }
    }

    private fun startClaimedEvent(context: Context, event: AlarmEvent, owner: RingerOwnership) {
      scheduleQueueMaintenance(context)
      PendingAlarmLedger.enqueue(
        sharedPendingAlarmStore(prefs(context)), event, event.firedAtMs ?: event.triggerAtMs,
      )
      val record = AlarmRecord(
        event.alarmId, event.triggerAtMs, event.deepLink, "", emptySet(), false,
        event.ringtoneUri, event.generation,
        title = android.net.Uri.parse(event.deepLink).getQueryParameter("alarmTitle")?.trim()?.take(40)?.ifBlank { "Alarm" } ?: "Alarm",
        snoozeMinutes = event.snoozeMinutes ?: AlarmSnoozeCoordinator.DEFAULT_INTERVAL_MINUTES,
      )
      if (!startRinger(context, record)) {
        AlarmEventLedger.transition(
          sharedAlarmEventStore(prefs(context)), event.eventId, event.generation, AlarmEventState.FAILED,
        )
        fallbackNotify(context, record)
        ownership.release(owner)
        pumpAlarmQueue(context)
      }
    }

    internal fun activeOwner(): RingerOwnership? = ownership.current()

    private fun ownerFor(eventId: String, generation: String): RingerOwnership? = ownership.current()
      ?.takeIf { it.eventId == eventId && it.generation == generation }

    private fun failReservedEvent(eventId: String, generation: String) {
      val context = instance?.applicationContext ?: return
      val owner = ownerFor(eventId, generation) ?: return
      AlarmEventLedger.transition(
        sharedAlarmEventStore(prefs(context)), eventId, generation, AlarmEventState.FAILED,
      )
      ownership.release(owner)
      Handler(Looper.getMainLooper()).post { pumpAlarmQueue(context) }
    }

    /** Pauses audio only for the exact occurrence. */
    fun mute(eventId: String, generation: String): Boolean {
      val inst = instance ?: return false
      val owner = ownership.current()?.takeIf { it.eventId == eventId && it.generation == generation } ?: return false
      Handler(Looper.getMainLooper()).post {
        ownership.runIfCurrent(owner) {
          if (instance === inst) inst.muteInternal(owner)
        }
      }
      return true
    }

    /** Full stop only for the exact occurrence. */
    fun stop(eventId: String, generation: String): Boolean {
      val inst = instance ?: return false
      val owner = ownership.current()?.takeIf { it.eventId == eventId && it.generation == generation } ?: return false
      try {
        Handler(Looper.getMainLooper()).post {
          ownership.runIfCurrent(owner) {
            if (instance === inst) {
              Log.i("MathWakeRinger", "service stop requested reason=explicit-stop alarmId=${owner.alarmId}")
              inst.stopOwned(owner)
            }
          }
        }
      } catch (_: Exception) {
        return false
      }
      return true
    }

    /** True while the ringer service owns this alarm (audio and/or notification). */
    fun isActive(alarmId: String): Boolean = ownership.current()?.alarmId == alarmId && instance != null

    /** True only while the alarm is audibly playing (not muted). */
    fun isRinging(eventId: String, generation: String): Boolean {
      val inst = instance ?: return false
      val owner = ownership.current() ?: return false
      if (eventId != owner.eventId || generation != owner.generation) return false
      return ownership.readIfCurrent(owner) { inst.resourceOwner == owner && inst.player?.isPlaying == true } == true
    }

    private fun foregroundServiceType(): Int =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      } else {
        0
      }
  }
}

/**
 * Builds the sticky, alarm-category, lock-screen notification owned by the
 * foreground ringer. It deliberately uses the SILENT ring channel: the audio
 * comes from the looping MediaPlayer, not from the channel sound, so there is
 * no double chime and the ring does not stop after a few seconds.
 */
internal fun buildRingNotification(context: Context, record: AlarmRecord, eventId: String, generation: String): Notification {
  ensureAlarmChannel(context)
  val openChallenge = challengePendingIntent(context, record.alarmId, record.deepLink, eventId, generation)
  val builder = NotificationCompat.Builder(context, CHANNEL_ID_RING)
    .setSmallIcon(smallIconRes(context))
    .setContentTitle(normalizeAlarmTitle(record.title))
    .setContentText("Saatnya bangun. Selesaikan tantangan untuk mematikan alarm.")
    .setCategory(NotificationCompat.CATEGORY_ALARM)
    .setPriority(NotificationCompat.PRIORITY_MAX)
    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
    .setOngoing(true)
    .setAutoCancel(false)
    .setOnlyAlertOnce(true)
    .setContentIntent(openChallenge)
  val event = AlarmEventLedger.get(sharedAlarmEventStore(prefs(context)), eventId)
  val interval = event?.snoozeMinutes?.takeIf { it in AlarmSnoozeCoordinator.ALLOWED_INTERVALS }
    ?: record.snoozeMinutes.takeIf { it in AlarmSnoozeCoordinator.ALLOWED_INTERVALS }
    ?: AlarmSnoozeCoordinator.DEFAULT_INTERVAL_MINUTES
  val snoozeTarget = event?.takeIf {
    it.alarmId == record.alarmId && it.generation == generation && it.state == AlarmEventState.RINGING
  }
  if (snoozeTarget != null) {
    builder.addAction(
      NotificationCompat.Action.Builder(
        smallIconRes(context),
        "Snooze ${interval} min",
        notificationSnoozePendingIntent(context, snoozeTarget, interval),
      ).build(),
    )
  }
  if (canUseFullScreenIntent(context)) {
    builder.setFullScreenIntent(openChallenge, true)
  }
  return builder.build()
}
