package expo.modules.mathwakealarm

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.util.Calendar
import java.util.UUID

// ---------------------------------------------------------------------------
// Native alarm backend for MathWake (Android).
//
// Why this exists: expo-notifications local notifications cannot run JS when
// the app is backgrounded or killed, and they offer no full-screen intent.
// So an alarm that fires while the phone is locked would only play a short
// notification sound until the user taps. This receiver instead:
//
//   1. Fires from AlarmManager.setAlarmClock (Doze-exempt, exact).
//   2. Posts a CATEGORY_ALARM full-screen notification whose intent launches
//      the app straight into /challenge via the mathwake:// deep link.
//   3. Once the app is in the foreground, the existing expo-audio loop
//      (challenge mount effect) takes over and rings until the user passes.
//
// The notification channel ID is intentionally identical to the one used by
// the expo-notifications JS path ("mathwake-alarms") so both engines share a
// single user-visible channel with the same sound.
// ---------------------------------------------------------------------------

internal const val ACTION_FIRE_ALARM = "expo.modules.mathwakealarm.ACTION_FIRE_ALARM"
internal const val ACTION_FIRE_SNOOZE = "expo.modules.mathwakealarm.ACTION_FIRE_SNOOZE"
internal const val ACTION_NOTIFICATION_SNOOZE = "expo.modules.mathwakealarm.ACTION_NOTIFICATION_SNOOZE"
internal const val ACTION_FIRE_TIMER = "expo.modules.mathwakealarm.ACTION_FIRE_TIMER"
internal const val ACTION_MAINTAIN_ALARM_QUEUE = "expo.modules.mathwakealarm.ACTION_MAINTAIN_ALARM_QUEUE"
internal const val EXTRA_ALARM_ID = "alarmId"
internal const val EXTRA_EVENT_ID = "eventId"
internal const val EXTRA_OCCURRENCE_TRIGGER = "occurrenceTriggerAtMs"
internal const val EXTRA_EVENT_GENERATION = "eventGeneration"
internal const val EXTRA_SNOOZE_MINUTES = "snoozeMinutes"
internal const val EXTRA_TIMER_DEADLINE = "timerDeadlineAtMs"
internal const val EXTRA_DEEP_LINK = "deepLink"
internal const val EXTRA_RINGTONE_URI = "ringtoneUri"
internal const val PREFS_NAME = "mathwake.alarms"
internal const val KEY_PENDING = "pendingAlarmId"
internal fun pendingEventKey(eventId: String) = "pending.event.$eventId"

internal fun sharedPendingAlarmStore(store: SharedPreferences): PendingAlarmStore = object : PendingAlarmStore {
  override fun read(eventId: String): String? = store.getString(pendingEventKey(eventId), null)
  override fun write(eventId: String, encoded: String): Boolean =
    store.edit().putString(pendingEventKey(eventId), encoded).commit()
  override fun remove(eventId: String): Boolean = store.edit().remove(pendingEventKey(eventId)).commit()
  override fun all(): List<Pair<String, String>> = store.all.mapNotNull { (key, value) ->
    if (!key.startsWith("pending.event.")) return@mapNotNull null
    (value as? String)?.let { key.removePrefix("pending.event.") to it }
  }
}

/**
 * Sounding channel, kept for the expo-notifications fallback engine and for
 * the degraded path where the foreground ringer cannot start.
 */
internal const val CHANNEL_ID = "mathwake-alarms"

/**
 * Silent channel owned by the looping foreground ringer. The audio comes from
 * AlarmRingerService's looping MediaPlayer, so the channel itself must not
 * play a sound (otherwise the short channel chime would overlap the loop).
 * High importance is still required for a heads-up / full-screen intent.
 */
internal const val CHANNEL_ID_RING = "mathwake-alarm-ring"
internal const val NOTIFICATION_ID = 1001
internal const val CHANNEL_ID_TIMER = "mathwake-timer"
internal const val TIMER_NOTIFICATION_ID = 1002
private const val TIMER_RECORD_KEY = "timer.main"
private const val TIMER_REQUEST_CODE = 0x4D57544
private const val QUEUE_MAINTENANCE_REQUEST_CODE = 0x4D574151

internal fun prefs(context: Context): SharedPreferences =
  context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

internal fun alarmRecordKey(alarmId: String) = "alarm.$alarmId"
internal fun normalizeAlarmTitle(title: String?): String = title?.trim()?.take(40)?.ifBlank { "Alarm" } ?: "Alarm"

internal data class AlarmRecord(
  val alarmId: String,
  val triggerAtMs: Long,
  val deepLink: String,
  val timeHHMM: String,
  val days: Set<Int>,
  val isRecurring: Boolean,
  val ringtoneUri: String = "android-resource://alarm",
  val eventGeneration: String? = null,
  val title: String = "Alarm",
  val snoozeMinutes: Int = AlarmSnoozeCoordinator.DEFAULT_INTERVAL_MINUTES,
)

internal fun readRecord(store: SharedPreferences, alarmId: String): AlarmRecord? {
  val raw = store.getString(alarmRecordKey(alarmId), null) ?: return null
  return try {
    val o = JSONObject(raw)
    AlarmRecord(
      alarmId = alarmId,
      triggerAtMs = o.optLong("triggerAtMs", 0L),
      deepLink = o.optString("deepLink", ""),
      timeHHMM = o.optString("time", ""),
      days = o.optString("days", "").split(",").mapNotNull { it.trim().toIntOrNull() }.toSet(),
      isRecurring = o.optBoolean("recurring", false),
      ringtoneUri = o.optString("ringtoneUri", "android-resource://alarm"),
      eventGeneration = o.optString("eventGeneration", "").takeIf { it.isNotBlank() },
      title = normalizeAlarmTitle(o.optString("title", "Alarm")),
      snoozeMinutes = o.optInt("snoozeMinutes", AlarmSnoozeCoordinator.DEFAULT_INTERVAL_MINUTES),
    )
  } catch (_: Exception) {
    null
  }
}

internal fun writeRecord(store: SharedPreferences, record: AlarmRecord, synchronous: Boolean = false): Boolean {
  val o = JSONObject()
    .put("triggerAtMs", record.triggerAtMs)
    .put("deepLink", record.deepLink)
    .put("time", record.timeHHMM)
    .put("days", record.days.sorted().joinToString(","))
    .put("recurring", record.isRecurring)
    .put("ringtoneUri", record.ringtoneUri)
    .put("title", normalizeAlarmTitle(record.title))
    .put("snoozeMinutes", record.snoozeMinutes)
  record.eventGeneration?.let { o.put("eventGeneration", it) }
  val editor = store.edit().putString(alarmRecordKey(record.alarmId), o.toString())
  if (synchronous) return editor.commit()
  editor.apply()
  return true
}

internal fun deleteRecord(store: SharedPreferences, alarmId: String) {
  store.edit().remove(alarmRecordKey(alarmId)).apply()
}

internal data class TimerRecord(val deadlineAtMs: Long)

private fun readTimerRecord(store: SharedPreferences): TimerRecord? {
  val raw = store.getString(TIMER_RECORD_KEY, null) ?: return null
  return try {
    TimerRecord(JSONObject(raw).optLong("deadlineAtMs", 0L))
  } catch (_: Exception) {
    null
  }
}

private fun writeTimerRecord(store: SharedPreferences, record: TimerRecord) {
  store.edit().putString(
    TIMER_RECORD_KEY,
    JSONObject().put("deadlineAtMs", record.deadlineAtMs).toString(),
  ).apply()
}

private fun deleteTimerRecord(store: SharedPreferences) {
  store.edit().remove(TIMER_RECORD_KEY).apply()
}

/**
 * Next trigger for a repeating alarm. `days` uses the JS convention
 * (0 = Sunday .. 6 = Saturday); an empty set means daily. Never returns a
 * moment in the past; returns null only for an unparseable time.
 */
internal fun nextRepeatingTriggerMs(timeHHMM: String, days: Set<Int>, nowMs: Long): Long? {
  val parts = timeHHMM.split(":")
  if (parts.size < 2) return null
  val hour = parts[0].toIntOrNull() ?: return null
  val minute = parts[1].toIntOrNull() ?: return null
  if (hour !in 0..23 || minute !in 0..59) return null
  val base = Calendar.getInstance().apply {
    timeInMillis = nowMs
    set(Calendar.SECOND, 0)
    set(Calendar.MILLISECOND, 0)
  }
  for (offset in 0..7) {
    val candidate = (base.clone() as Calendar).apply {
      add(Calendar.DAY_OF_YEAR, offset)
      set(Calendar.HOUR_OF_DAY, hour)
      set(Calendar.MINUTE, minute)
    }
    if (offset == 0 && candidate.timeInMillis <= nowMs) continue
    // Calendar.SUNDAY == 1 .. Calendar.SATURDAY == 7; shift to 0..6.
    val dayZeroBased = candidate.get(Calendar.DAY_OF_WEEK) - Calendar.SUNDAY
    if (days.isEmpty() || dayZeroBased in days) return candidate.timeInMillis
  }
  return null
}

internal fun fireIntent(
  context: Context,
  alarmId: String,
  triggerAtMs: Long = 0L,
  generation: String? = null,
): Intent =
  Intent(context, MathWakeAlarmReceiver::class.java).apply {
    action = ACTION_FIRE_ALARM
    data = Uri.parse(AlarmEventLedger.scheduleIdentity(alarmId))
    putExtra(EXTRA_ALARM_ID, alarmId)
    if (triggerAtMs > 0L) putExtra(EXTRA_OCCURRENCE_TRIGGER, triggerAtMs)
    generation?.let { putExtra(EXTRA_EVENT_GENERATION, it) }
  }

/** Independent AlarmManager identity for one Snooze occurrence. */
internal fun snoozeFireIntent(context: Context, event: AlarmEvent): Intent =
  Intent(context, MathWakeAlarmReceiver::class.java).apply {
    action = ACTION_FIRE_SNOOZE
    data = Uri.parse(AlarmEventLedger.snoozeScheduleIdentity(event.eventId))
    putExtra(EXTRA_ALARM_ID, event.alarmId)
    putExtra(EXTRA_EVENT_ID, event.eventId)
    putExtra(EXTRA_OCCURRENCE_TRIGGER, event.triggerAtMs)
    putExtra(EXTRA_EVENT_GENERATION, event.generation)
  }

/** Broadcast action performs Snooze natively even when the JS runtime is absent. */
internal fun notificationSnoozeIntent(context: Context, event: AlarmEvent, intervalMinutes: Int): Intent =
  Intent(context, MathWakeAlarmReceiver::class.java).apply {
    action = ACTION_NOTIFICATION_SNOOZE
    data = Uri.parse(AlarmEventLedger.notificationSnoozeIdentity(event.eventId))
    putExtra(EXTRA_ALARM_ID, event.alarmId)
    putExtra(EXTRA_EVENT_ID, event.eventId)
    putExtra(EXTRA_EVENT_GENERATION, event.generation)
    putExtra(EXTRA_SNOOZE_MINUTES, intervalMinutes)
  }

internal fun notificationSnoozePendingIntent(context: Context, event: AlarmEvent, intervalMinutes: Int): PendingIntent =
  PendingIntent.getBroadcast(
    context,
    stablePendingIntentRequestCode(context, "notification-snooze:${event.eventId}"),
    notificationSnoozeIntent(context, event, intervalMinutes),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

/** Shared implementation for the JS bridge and the notification BroadcastReceiver. */
internal fun snoozeRingingOccurrence(
  context: Context,
  alarmId: String,
  eventId: String,
  generation: String,
  intervalMinutes: Int,
  requireConfiguredInterval: Boolean = false,
): SnoozeOperationResult {
  val store = sharedAlarmEventStore(prefs(context))
  val source = AlarmEventLedger.get(store, eventId)
    ?: return SnoozeOperationResult(false, reason = "event-missing")
  if (source.alarmId != alarmId || source.generation != generation) {
    return SnoozeOperationResult(false, reason = "identity-mismatch")
  }
  if (requireConfiguredInterval && source.snoozeMinutes != intervalMinutes) {
    return SnoozeOperationResult(false, reason = "interval-mismatch")
  }
  val result = AlarmSnoozeCoordinator.snooze(
    store = store,
    alarmId = alarmId,
    eventId = eventId,
    generation = generation,
    requestedIntervalMinutes = intervalMinutes,
    nowMs = System.currentTimeMillis(),
    activeOwner = AlarmRingerService.activeOwner(),
    schedule = { event -> scheduleSnoozeSystem(context, event, allowPreparedSource = true) },
    cancel = { event -> cancelSnoozeSystem(context, event) },
    stop = { AlarmRingerService.stop(eventId, generation) },
  )
  if (result.success && !result.alreadyScheduled) {
    prefs(context).edit().remove(pendingEventKey(eventId)).commit()
    runCatching {
      (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
        .cancel(eventId, NOTIFICATION_ID)
    }
  }
  return result
}

/** Arms a standalone Snooze event; it never reuses the base alarm PendingIntent. */
internal fun scheduleSnoozeSystem(context: Context, event: AlarmEvent, allowPreparedSource: Boolean = false): SnoozeScheduleOutcome {
  val store = sharedAlarmEventStore(prefs(context))
  val source = event.sourceEventId?.let { AlarmEventLedger.get(store, it) }
  val liveSource = AlarmSnoozeCoordinator.hasLiveSnoozeSource(store, event)
  val preparedSource = allowPreparedSource && source != null && source.alarmId == event.alarmId &&
    source.generation == event.sourceGeneration && source.state == AlarmEventState.RINGING && source.snoozedToEventId == null
  if (!event.isSnooze || event.state != AlarmEventState.SCHEDULED || (!liveSource && !preparedSource)) {
    return SnoozeScheduleOutcome(false, reason = "invalid-snooze-source")
  }
  return try {
    val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val requestCode = stablePendingIntentRequestCode(context, event.eventId)
    val firePi = PendingIntent.getBroadcast(
      context, requestCode, snoozeFireIntent(context, event),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val exactAllowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      runCatching { am.canScheduleExactAlarms() }.getOrDefault(false)
    } else true
    if (exactAllowed) {
      val showPi = challengePendingIntent(context, event.alarmId, event.deepLink, event.eventId, event.generation)
      am.setAlarmClock(AlarmManager.AlarmClockInfo(event.triggerAtMs, showPi), firePi)
    } else {
      am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, event.triggerAtMs, firePi)
    }
    SnoozeScheduleOutcome(true, exactAllowed)
  } catch (e: Exception) {
    cancelSnoozeSystem(context, event)
    SnoozeScheduleOutcome(false, reason = e.message ?: "schedule-failed")
  }
}

internal fun cancelSnoozeSystem(context: Context, event: AlarmEvent) {
  val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
  val requestCode = stablePendingIntentRequestCode(context, event.eventId)
  val pi = runCatching {
    PendingIntent.getBroadcast(
      context, requestCode, snoozeFireIntent(context, event),
      PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
    )
  }.getOrNull() ?: return
  runCatching { am.cancel(pi) }
  runCatching { pi.cancel() }
}

/** Identity used by versions that scheduled alarm broadcasts by hash only. */
private fun legacyFireIntent(context: Context, alarmId: String): Intent =
  Intent(context, MathWakeAlarmReceiver::class.java).apply {
    action = ACTION_FIRE_ALARM
    putExtra(EXTRA_ALARM_ID, alarmId)
  }

internal fun timerFireIntent(context: Context, deadlineAtMs: Long = 0L): Intent =
  Intent(context, MathWakeAlarmReceiver::class.java).apply {
    action = ACTION_FIRE_TIMER
    if (deadlineAtMs > 0L) putExtra(EXTRA_TIMER_DEADLINE, deadlineAtMs)
  }

internal fun queueMaintenanceIntent(context: Context): Intent = Intent(context, MathWakeAlarmReceiver::class.java).apply {
  action = ACTION_MAINTAIN_ALARM_QUEUE
  data = Uri.parse("mathwake-alarm://queue-maintenance")
}

/** Arms one durable maintenance broadcast at the oldest queued event's expiry boundary. */
internal fun scheduleQueueMaintenance(context: Context) {
  val store = prefs(context)
  val queueStore = sharedAlarmEventStore(store)
  val queued = AlarmEventLedger.all(queueStore).filter { it.state == AlarmEventState.QUEUED && !it.isSnooze }
  val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
  val pi = PendingIntent.getBroadcast(
    context, QUEUE_MAINTENANCE_REQUEST_CODE, queueMaintenanceIntent(context),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )
  if (queued.isEmpty()) {
    am.cancel(pi)
    pi.cancel()
    return
  }
  val deadline = queued.minOf { runCatching { Math.addExact(it.triggerAtMs, AlarmEventQueue.MAX_QUEUE_AGE_MS) }.getOrDefault(Long.MAX_VALUE) }
  val whenMs = maxOf(System.currentTimeMillis(), deadline)
  val exactAllowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    runCatching { am.canScheduleExactAlarms() }.getOrDefault(false)
  } else true
  try {
    if (exactAllowed) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, whenMs, pi)
    else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, whenMs, pi)
  } catch (_: Exception) {
    runCatching { am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, whenMs, pi) }
  }
}

/** PendingIntent that opens the app directly on the challenge screen. */
internal fun challengePendingIntent(context: Context, alarmId: String, deepLink: String, eventId: String = "", generation: String = ""): PendingIntent {
  val occurrenceLink = runCatching {
    Uri.parse(deepLink).buildUpon()
      .appendQueryParameter("eventId", eventId)
      .appendQueryParameter("generation", generation)
      .appendQueryParameter("triggerAtMs", eventId.split(':').getOrNull(2).orEmpty())
      .build()
  }.getOrElse { Uri.parse(deepLink) }
  val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
    action = Intent.ACTION_VIEW
    data = occurrenceLink
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
  } ?: Intent(Intent.ACTION_VIEW, occurrenceLink).apply {
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
  }
  return PendingIntent.getActivity(
    context,
    stablePendingIntentRequestCode(context, eventId),
    launch,
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )
}

/** Monotonic persisted allocator; unlike String.hashCode this cannot silently collide. */
private fun stablePendingIntentRequestCode(context: Context, eventId: String): Int {
  val store = prefs(context)
  return PendingIntentIdentity.requestCode(object : PendingIntentCodeStore {
    override fun read(eventId: String): Int? = store.getInt("pendingIntent.$eventId", 0).takeIf { it > 0 }
    override fun allCodes(): Set<Int> = store.all.mapNotNull { (key, value) ->
      if (key.startsWith("pendingIntent.") && key != "pendingIntent.next") (value as? Int)?.takeIf { it > 0 } else null
    }.toSet()
    override fun nextCode(): Int = store.getInt("pendingIntent.next", 20_000) + 1
    override fun writeMappingAndNext(eventId: String, code: Int): Boolean = store.edit()
      .putInt("pendingIntent.next", code)
      .putInt("pendingIntent.$eventId", code)
      .commit()
  }, eventId)
}

internal fun alarmSoundUri(context: Context, ringtoneUri: String = "android-resource://alarm"): Uri {
  if (ringtoneUri == "android-system-alarm://default") {
    return RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
      ?: throw IllegalStateException("system-alarm-uri-unavailable")
  }
  if (ringtoneUri.startsWith("file://")) return Uri.parse(ringtoneUri)
  if (ringtoneUri.startsWith("android.resource://")) {
    val candidate = Uri.parse(ringtoneUri)
    return try {
      context.contentResolver.openAssetFileDescriptor(candidate, "r")?.use { return candidate }
      throw IllegalStateException("resource-ringtone-unavailable")
    } catch (e: Exception) {
      Log.e("MathWakeRingtoneTrace", "resource ringtone unavailable reason=${e.javaClass.simpleName}")
      throw e
    }
  }
  if (ringtoneUri.startsWith("content://")) {
    val candidate = Uri.parse(ringtoneUri)
    try {
      context.contentResolver.openAssetFileDescriptor(candidate, "r")?.use {
        Log.i("MathWakeRingtoneTrace", "using custom ringtone scheme=content")
        return candidate
      }
        Log.e("MathWakeRingtoneTrace", "custom ringtone unavailable reason=no-descriptor")
        throw IllegalStateException("content-ringtone-unavailable")
    } catch (e: Exception) {
      Log.e("MathWakeRingtoneTrace", "custom ringtone unavailable reason=${e.javaClass.simpleName}")
      throw e
    }
  }
  if (ringtoneUri == "android-resource://alarm") return bundledAlarmSoundUri(context)
  throw IllegalArgumentException("unsupported-ringtone-scheme")
}

private fun bundledAlarmSoundUri(context: Context): Uri {
  val rawId = context.resources.getIdentifier("alarm", "raw", context.packageName)
  return if (rawId != 0) {
    Uri.parse("android.resource://${context.packageName}/$rawId")
  } else {
    Log.e("MathWakeRingtoneTrace", "bundled ringtone resource missing")
    throw IllegalStateException("bundled-ringtone-resource-missing")
  }
}

internal fun ensureAlarmChannel(context: Context) {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
  val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
  // Creating a channel with an existing ID is a no-op for user-modified
  // settings, so sharing the ID with the expo-notifications path is safe.
  val audioAttrs = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ALARM)
    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
    .build()
  val channel = NotificationChannel(CHANNEL_ID, "Alarm MathWake", NotificationManager.IMPORTANCE_HIGH).apply {
    description = "Alarm MathWake — bunyi saat waktunya bangun"
    setSound(alarmSoundUri(context), audioAttrs)
    enableVibration(true)
    vibrationPattern = longArrayOf(0, 500, 250, 500)
    lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
    setBypassDnd(false)
    setShowBadge(true)
  }
  nm.createNotificationChannel(channel)

  // Silent channel for the looping foreground ringer (audio = MediaPlayer).
  val ringChannel = NotificationChannel(
    CHANNEL_ID_RING,
    "Alarm MathWake (bunyi terus-menerus)",
    NotificationManager.IMPORTANCE_HIGH,
  ).apply {
    description = "Alarm MathWake — bunyi terus-menerus sampai tantangan selesai"
    setSound(null, null)
    enableVibration(true)
    vibrationPattern = longArrayOf(0, 500, 250, 500)
    lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
    setBypassDnd(false)
    setShowBadge(true)
  }
  nm.createNotificationChannel(ringChannel)
}

internal fun smallIconRes(context: Context): Int {
  // Icon generated by the expo-notifications config plugin ("icon" option).
  val id = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
  return if (id != 0) id else android.R.drawable.ic_lock_idle_alarm
}

/**
 * Full-screen intent is gated on Android 14+ (API 34): without the
 * USE_FULL_SCREEN_INTENT grant the call is still safe, but the system may
 * only show a heads-up notification instead of launching the app. Below
 * API 34 the permission model does not exist and fullscreen just works.
 */
internal fun canUseFullScreenIntent(context: Context): Boolean {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
  val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
  return try {
    nm.canUseFullScreenIntent()
  } catch (_: Exception) {
    true
  }
}

internal fun showAlarmNotification(context: Context, record: AlarmRecord) {
  // Preferred path: start the looping foreground ringer. It owns both the
  // audio and the sticky notification, and keeps ringing on the lock screen /
  // in the background without any user interaction.
  if (AlarmRingerService.startRinger(context, record)) return
  // Degraded fallback when the OS refuses the foreground service: post the
  // sounding-channel notification so the alarm is at least not silent.
  fallbackNotify(context, record)
}

/** Sounding-channel notification used only when the foreground ringer fails. */
internal fun fallbackNotify(context: Context, record: AlarmRecord) {
  ensureAlarmChannel(context)
  val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
  val generation = record.eventGeneration ?: return
  val eventId = AlarmEventLedger.eventId(record.alarmId, record.triggerAtMs, generation)
  val openChallenge = challengePendingIntent(context, record.alarmId, record.deepLink, eventId, generation)
  // This is an error/degraded path. Keep it silent so a failed selected URI
  // never changes the audible alarm to the bundled channel sound.
  val builder = NotificationCompat.Builder(context, CHANNEL_ID_RING)
    .setSmallIcon(smallIconRes(context))
    .setContentTitle(normalizeAlarmTitle(record.title))
    .setContentText("Saatnya bangun. Selesaikan tantangan untuk mematikan alarm.")
    .setCategory(NotificationCompat.CATEGORY_ALARM)
    .setPriority(NotificationCompat.PRIORITY_MAX)
    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
    .setOngoing(true)
    .setAutoCancel(false)
    .setOnlyAlertOnce(false)
    .setVibrate(longArrayOf(0, 500, 250, 500))
    .setSilent(true)
    .setContentIntent(openChallenge)
  if (canUseFullScreenIntent(context)) {
    builder.setFullScreenIntent(openChallenge, true)
  }
  nm.notify(eventId, NOTIFICATION_ID, builder.build())
}

/**
 * Arms the AlarmManager for the given record. Returns true when an exact
 * alarm was set; false when falling back to inexact (exact-alarm permission
 * denied on Android 12+). Callers must surface the fallback truthfully.
 */
internal fun setExactAlarm(context: Context, record: AlarmRecord): Boolean {
  val generation = record.eventGeneration
    ?: throw IllegalArgumentException("alarm-event-generation-required")
  val event = AlarmEventLedger.scheduled(
    record.alarmId, record.triggerAtMs, generation, record.deepLink, record.ringtoneUri,
  )
  if (AlarmEventLedger.ensureScheduled(sharedAlarmEventStore(prefs(context)), event) == null) {
    throw IllegalStateException("alarm-event-ledger-write-failed")
  }
  val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
  cancelLegacySystemAlarm(context, record.alarmId)
  val firePi = PendingIntent.getBroadcast(
    context,
    0,
    fireIntent(context, record.alarmId, record.triggerAtMs, generation),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )
  val exactAllowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    try {
      am.canScheduleExactAlarms()
    } catch (_: Exception) {
      false
    }
  } else {
    true
  }
  if (exactAllowed) {
    val showPi = challengePendingIntent(context, record.alarmId, record.deepLink, event.eventId, generation)
    am.setAlarmClock(AlarmManager.AlarmClockInfo(record.triggerAtMs, showPi), firePi)
    return true
  }
  am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, record.triggerAtMs, firePi)
  return false
}

internal fun cancelSystemAlarm(context: Context, alarmId: String) {
  val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
  val pi = try {
    PendingIntent.getBroadcast(
      context,
      0,
      fireIntent(context, alarmId),
      PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
    )
  } catch (_: Exception) {
    null
  }
  if (pi != null) {
    try {
      am.cancel(pi)
    } catch (_: Exception) {
    } finally {
      try {
        pi.cancel()
      } catch (_: Exception) {
      }
    }
  }
  cancelLegacySystemAlarm(context, alarmId)
}

private fun cancelLegacySystemAlarm(context: Context, alarmId: String) {
  val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
  val legacy = try {
    PendingIntent.getBroadcast(
      context,
      alarmId.hashCode(),
      legacyFireIntent(context, alarmId),
      PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
    )
  } catch (_: Exception) {
    null
  } ?: return
  try { am.cancel(legacy) } catch (_: Exception) { }
  try { legacy.cancel() } catch (_: Exception) { }
}

internal fun alarmEventKey(eventId: String) = AlarmEventLedger.storageKey(eventId)

internal fun sharedAlarmEventStore(store: SharedPreferences): AlarmEventStore = object : AlarmEventStore {
  override fun read(eventId: String): String? = store.getString(alarmEventKey(eventId), null)
  override fun write(eventId: String, value: String): Boolean =
    store.edit().putString(alarmEventKey(eventId), value).commit()
  override fun all(): List<Pair<String, String>> = store.all.mapNotNull { (key, value) ->
    if (!key.startsWith("event.")) return@mapNotNull null
    val eventId = key.removePrefix("event.")
    (value as? String)?.let { eventId to it }
  }
}

internal data class TimerScheduleOutcome(
  val scheduled: Boolean,
  val exact: Boolean,
  val reason: String? = null,
)

internal fun scheduleTimerSystem(context: Context, deadlineAtMs: Long): TimerScheduleOutcome {
  if (deadlineAtMs <= System.currentTimeMillis()) {
    cancelTimerSystem(context)
    return TimerScheduleOutcome(false, false, "deadline-past")
  }
  val store = prefs(context)
  cancelTimerSystem(context)
  val record = TimerRecord(deadlineAtMs)
  writeTimerRecord(store, record)
  return try {
    val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val firePi = PendingIntent.getBroadcast(
      context,
      TIMER_REQUEST_CODE,
      timerFireIntent(context, deadlineAtMs),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val exactAllowed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try { am.canScheduleExactAlarms() } catch (_: Exception) { false }
    } else true
    if (exactAllowed) {
      am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, deadlineAtMs, firePi)
    } else {
      am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, deadlineAtMs, firePi)
    }
    TimerScheduleOutcome(true, exactAllowed)
  } catch (e: Exception) {
    deleteTimerRecord(store)
    TimerScheduleOutcome(false, false, e.message ?: "schedule-failed")
  }
}

internal fun cancelTimerSystem(context: Context) {
  val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
  val pi = try {
    PendingIntent.getBroadcast(
      context,
      TIMER_REQUEST_CODE,
      timerFireIntent(context),
      PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
    )
  } catch (_: Exception) { null } ?: run {
    deleteTimerRecord(prefs(context))
    return
  }
  try { am.cancel(pi) } catch (_: Exception) {
  } finally {
    try { pi.cancel() } catch (_: Exception) { }
    deleteTimerRecord(prefs(context))
  }
}

internal fun ensureTimerChannel(context: Context) {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
  val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
  val channel = NotificationChannel(
    CHANNEL_ID_TIMER,
    "Timer MathWake",
    NotificationManager.IMPORTANCE_HIGH,
  ).apply {
    description = "Notifikasi saat Timer MathWake selesai"
    setSound(null, null)
    enableVibration(false)
    lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
    setShowBadge(true)
  }
  nm.createNotificationChannel(channel)
}

internal fun showTimerNotification(context: Context) {
  ensureTimerChannel(context)
  val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
  val builder = NotificationCompat.Builder(context, CHANNEL_ID_TIMER)
    .setSmallIcon(smallIconRes(context))
    .setContentTitle("Timer selesai")
    .setContentText("Waktu timer telah habis.")
    .setCategory(NotificationCompat.CATEGORY_STATUS)
    .setPriority(NotificationCompat.PRIORITY_HIGH)
    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
    .setAutoCancel(true)
    .setOngoing(false)
    .setSilent(true)
  if (launch != null) builder.setContentIntent(
    PendingIntent.getActivity(
      context,
      TIMER_REQUEST_CODE,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    ),
  )
  val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
  nm.notify(TIMER_NOTIFICATION_ID, builder.build())
}

class MathWakeAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val appCtx = context.applicationContext
    val store = prefs(appCtx)
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED -> {
        rescheduleAll(appCtx, store)
        rescheduleTimer(appCtx, store)
        restoreSnoozeSchedules(appCtx, store)
        scheduleQueueMaintenance(appCtx)
        AlarmRingerService.restoreAndPump(appCtx)
        return
      }
      ACTION_MAINTAIN_ALARM_QUEUE -> {
        AlarmEventQueue.expireQueued(sharedAlarmEventStore(store), System.currentTimeMillis())
        scheduleQueueMaintenance(appCtx)
        AlarmRingerService.pumpAlarmQueue(appCtx)
        return
      }
      ACTION_FIRE_ALARM -> {
        val alarmId = intent.getStringExtra(EXTRA_ALARM_ID) ?: return
        val record = readRecord(store, alarmId) ?: return
        val requestedTrigger = intent.getLongExtra(EXTRA_OCCURRENCE_TRIGGER, 0L)
        val requestedGeneration = intent.getStringExtra(EXTRA_EVENT_GENERATION)
        if (requestedTrigger > 0L && requestedTrigger != record.triggerAtMs) return
        if (requestedGeneration != record.eventGeneration) return
        if (System.currentTimeMillis() < record.triggerAtMs) {
          // Inexact fallback or an early broadcast must never start audio early.
          try { setExactAlarm(appCtx, record) } catch (_: Exception) { }
          return
        }
        val generation = record.eventGeneration ?: UUID.randomUUID().toString()
        val firedRecord = if (record.eventGeneration == null) {
          record.copy(eventGeneration = generation).also { writeRecord(store, it) }
        } else record
        val eventId = AlarmEventLedger.eventId(alarmId, firedRecord.triggerAtMs, generation)
        val eventStore = sharedAlarmEventStore(store)
        val event = AlarmEventLedger.ensureScheduled(
          eventStore,
          AlarmEventLedger.scheduled(
            alarmId, firedRecord.triggerAtMs, generation, firedRecord.deepLink, firedRecord.ringtoneUri,
            snoozeMinutes = firedRecord.snoozeMinutes,
          ),
        ) ?: return
        val firedAtMs = System.currentTimeMillis()
        val queued = AlarmEventQueue.enqueue(eventStore, event.copy(firedAtMs = firedAtMs)) ?: return
        Log.i("MathWakeRingtoneTrace", "receiver alarmId=$alarmId scheme=${Uri.parse(record.ringtoneUri).scheme ?: "none"}")
        Log.i("MathWakeAlarm", "fired alarmId=$alarmId recurring=${record.isRecurring}")
        if (firedRecord.isRecurring) {
          // Arm the next occurrence FIRST so repeating alarms survive even
          // if the app is never opened after this fire.
          val next = nextRepeatingTriggerMs(firedRecord.timeHHMM, firedRecord.days, System.currentTimeMillis())
          if (next != null) {
            val updated = firedRecord.copy(triggerAtMs = next, eventGeneration = UUID.randomUUID().toString())
            writeRecord(store, updated)
            try {
              setExactAlarm(appCtx, updated)
            } catch (_: Exception) {
            }
          } else {
            deleteRecord(store, alarmId)
          }
        } else {
          // One-shot consumed. The sticky notification stays until solved.
          deleteRecord(store, alarmId)
        }
        // Remember the fired alarm (with timestamp) so JS can route to the
        // challenge on cold start, even before any tap is delivered.
        PendingAlarmLedger.enqueue(sharedPendingAlarmStore(store), queued, firedAtMs)
        scheduleQueueMaintenance(appCtx)
        AlarmRingerService.pumpAlarmQueue(appCtx)
      }
      ACTION_FIRE_SNOOZE -> handleSnoozeFire(appCtx, intent)
      ACTION_NOTIFICATION_SNOOZE -> handleNotificationSnooze(appCtx, intent)
      ACTION_FIRE_TIMER -> {
        val record = readTimerRecord(store) ?: return
        if (record.deadlineAtMs <= 0L) {
          deleteTimerRecord(store)
          return
        }
        val firedDeadline = intent.getLongExtra(EXTRA_TIMER_DEADLINE, 0L)
        if (firedDeadline != 0L && firedDeadline != record.deadlineAtMs) return
        if (System.currentTimeMillis() < record.deadlineAtMs) {
          // A stale or early delivery must not notify before the Timer deadline.
          // Keep the record and replace the one-shot alarm with the same deadline.
          scheduleTimerSystem(appCtx, record.deadlineAtMs)
          return
        }
        // Consume before notifying so duplicate broadcasts are harmless.
        deleteTimerRecord(store)
        try { showTimerNotification(appCtx) } catch (_: Exception) { }
      }
      else -> return
    }
  }

  private fun handleNotificationSnooze(context: Context, intent: Intent) {
    val alarmId = intent.getStringExtra(EXTRA_ALARM_ID) ?: return
    val eventId = intent.getStringExtra(EXTRA_EVENT_ID) ?: return
    val generation = intent.getStringExtra(EXTRA_EVENT_GENERATION) ?: return
    val intervalMinutes = intent.getIntExtra(EXTRA_SNOOZE_MINUTES, -1)
    val result = snoozeRingingOccurrence(context, alarmId, eventId, generation, intervalMinutes, requireConfiguredInterval = true)
    if (!result.success) {
      Log.w("MathWakeAlarm", "notification snooze rejected eventId=$eventId reason=${result.reason}")
    }
  }

  private fun handleSnoozeFire(context: Context, intent: Intent) {
    val alarmId = intent.getStringExtra(EXTRA_ALARM_ID) ?: return
    val eventId = intent.getStringExtra(EXTRA_EVENT_ID) ?: return
    val generation = intent.getStringExtra(EXTRA_EVENT_GENERATION) ?: return
    val requestedTrigger = intent.getLongExtra(EXTRA_OCCURRENCE_TRIGGER, 0L)
    val store = sharedAlarmEventStore(prefs(context))
    val event = AlarmEventLedger.get(store, eventId) ?: return
    if (!event.isSnooze || event.alarmId != alarmId || event.generation != generation || event.triggerAtMs != requestedTrigger) return
    if (!AlarmSnoozeCoordinator.hasLiveSnoozeSource(store, event)) {
      AlarmEventLedger.transition(store, eventId, generation, AlarmEventState.STOPPED)
      return
    }
    if (System.currentTimeMillis() < event.triggerAtMs) {
      scheduleSnoozeSystem(context, event)
      return
    }
    val queued = AlarmEventQueue.enqueue(store, event) ?: return
    PendingAlarmLedger.enqueue(
      sharedPendingAlarmStore(prefs(context)), queued, queued.firedAtMs ?: System.currentTimeMillis(),
    )
    scheduleQueueMaintenance(context)
    AlarmRingerService.pumpAlarmQueue(context)
  }

  private fun restoreSnoozeSchedules(context: Context, store: SharedPreferences) {
    val events = sharedAlarmEventStore(store)
    val now = System.currentTimeMillis()
    AlarmEventLedger.all(events)
      .filter { it.state == AlarmEventState.SCHEDULED && it.isSnooze && !AlarmSnoozeCoordinator.hasLiveSnoozeSource(events, it) }
      .forEach { AlarmEventLedger.transition(events, it.eventId, it.generation, AlarmEventState.STOPPED) }
    for (event in AlarmSnoozeCoordinator.recoverableScheduledEvents(events)) {
      if (event.triggerAtMs <= now) {
        val queued = AlarmEventQueue.enqueue(events, event) ?: continue
        PendingAlarmLedger.enqueue(sharedPendingAlarmStore(store), queued, now)
      } else {
        val outcome = scheduleSnoozeSystem(context, event)
        if (!outcome.scheduled) {
          Log.e("MathWakeAlarm", "snooze restore failed eventId=${event.eventId} reason=${outcome.reason}")
        }
      }
    }
  }

  private fun rescheduleAll(context: Context, store: SharedPreferences) {
    val now = System.currentTimeMillis()
    // Snapshot keys first: rescheduling mutates the store.
    val keys = store.all.keys.filter { it.startsWith("alarm.") }.toList()
    for (key in keys) {
      val alarmId = key.removePrefix("alarm.")
      val record = readRecord(store, alarmId) ?: continue
      if (record.isRecurring) {
        val next = nextRepeatingTriggerMs(record.timeHHMM, record.days, now) ?: continue
        val generation = if (next == record.triggerAtMs) {
          record.eventGeneration ?: UUID.randomUUID().toString()
        } else {
          val previousGeneration = record.eventGeneration
          if (previousGeneration != null) {
          val previousEventId = AlarmEventLedger.eventId(alarmId, record.triggerAtMs, previousGeneration)
          val previousStore = sharedAlarmEventStore(store)
          AlarmEventLedger.ensureScheduled(
            previousStore,
            AlarmEventLedger.scheduled(alarmId, record.triggerAtMs, previousGeneration),
          )
          val previous = AlarmEventLedger.get(previousStore, previousEventId)
          if (previous?.state == AlarmEventState.SCHEDULED) {
            AlarmEventLedger.transition(previousStore, previousEventId, previousGeneration, AlarmEventState.EXPIRED)
          }
          }
          UUID.randomUUID().toString()
        }
        val updated = record.copy(triggerAtMs = next, eventGeneration = generation)
        writeRecord(store, updated)
        try {
          setExactAlarm(context, updated)
        } catch (_: Exception) {
        }
      } else if (record.triggerAtMs > now) {
        val current = record.eventGeneration?.let { record } ?: record.copy(eventGeneration = UUID.randomUUID().toString())
        if (current !== record) writeRecord(store, current)
        try {
          setExactAlarm(context, current)
        } catch (_: Exception) {
        }
      } else {
        val generation = record.eventGeneration ?: UUID.randomUUID().toString()
        val expiredRecord = record.copy(eventGeneration = generation)
        if (record.eventGeneration == null) writeRecord(store, expiredRecord)
        val eventStore = sharedAlarmEventStore(store)
        val eventId = AlarmEventLedger.eventId(alarmId, record.triggerAtMs, generation)
        AlarmEventLedger.ensureScheduled(eventStore, AlarmEventLedger.scheduled(alarmId, record.triggerAtMs, generation))
        if (AlarmEventLedger.get(eventStore, eventId)?.state == AlarmEventState.SCHEDULED) {
          AlarmEventLedger.transition(eventStore, eventId, generation, AlarmEventState.EXPIRED)
        }
        // Past one-time alarm: drop it. The JS resync expires the server
        // row truthfully the next time the app opens.
        deleteRecord(store, alarmId)
      }
    }
  }

  private fun rescheduleTimer(context: Context, store: SharedPreferences) {
    val record = readTimerRecord(store) ?: return
    if (record.deadlineAtMs > System.currentTimeMillis()) {
      scheduleTimerSystem(context, record.deadlineAtMs)
    } else {
      deleteTimerRecord(store)
      try { showTimerNotification(context) } catch (_: Exception) { }
    }
  }
}
