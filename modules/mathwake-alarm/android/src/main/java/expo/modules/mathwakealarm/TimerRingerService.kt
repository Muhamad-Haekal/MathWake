package expo.modules.mathwakealarm

import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.ServiceCompat

/** Isolated Timer audio owner; it never reads or changes alarm occurrence state. */
internal class TimerRingerService : Service() {
  private var player: MediaPlayer? = null
  private var audioManager: AudioManager? = null
  private var audioFocusListener: AudioManager.OnAudioFocusChangeListener? = null
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (player?.isPlaying == true) return START_NOT_STICKY
    try {
      ServiceCompat.startForeground(this, TIMER_NOTIFICATION_ID,
        buildTimerNotification(this, CHANNEL_ID_TIMER, foregroundService = true), foregroundServiceType())
      acquireAudioFocus()
      acquireWakeLock()
      player = MediaPlayer().apply {
        setAudioAttributes(AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_ALARM)
          .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
          .build())
        setDataSource(this@TimerRingerService, alarmSoundUri(this@TimerRingerService))
        isLooping = true
        setOnErrorListener { _, what, extra ->
          Log.e(TAG, "player error what=$what extra=$extra")
          ServiceCompat.stopForeground(this@TimerRingerService, ServiceCompat.STOP_FOREGROUND_REMOVE)
          stopSelf(startId)
          true
        }
        prepare()
        start()
      }
      Log.i(TAG, "Timer MathWake sound started")
    } catch (e: Exception) {
      Log.e(TAG, "Timer MathWake sound failed", e)
      releaseAudio()
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      stopSelf(startId)
      ensureTimerFallbackChannel(this)
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
      nm.notify(TIMER_NOTIFICATION_ID, buildTimerNotification(this, CHANNEL_ID_TIMER_FALLBACK))
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseAudio()
    super.onDestroy()
  }

  private fun acquireAudioFocus() {
    val manager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val listener = AudioManager.OnAudioFocusChangeListener { change ->
      // An alarm must remain audible when a transient sound (e.g. navigation
      // prompt) ducks or pauses other audio. Stop/dismiss remains user-owned.
      if (change == AudioManager.AUDIOFOCUS_LOSS) Log.w(TAG, "permanent audio focus loss")
    }
    audioManager = manager
    audioFocusListener = listener
    @Suppress("DEPRECATION")
    val result = manager.requestAudioFocus(listener, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) Log.w(TAG, "audio focus not granted result=$result")
  }

  private fun acquireWakeLock() {
    val manager = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MathWake:TimerRinger").apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  private fun releaseAudio() {
    try { player?.stop() } catch (_: Exception) { }
    try { player?.release() } catch (_: Exception) { }
    player = null
    audioFocusListener?.let { listener ->
      try {
        @Suppress("DEPRECATION")
        audioManager?.abandonAudioFocus(listener)
      } catch (_: Exception) { }
    }
    audioFocusListener = null
    audioManager = null
    try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) { }
    wakeLock = null
  }

  private fun foregroundServiceType(): Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
  } else 0

  companion object {
    private const val TAG = "MathWakeTimer"

    fun start(context: Context) {
      val intent = Intent(context, TimerRingerService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
    }
  }
}
