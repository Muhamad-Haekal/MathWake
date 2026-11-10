package expo.modules.mathwakealarm

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.media.RingtoneManager
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MathWakeAlarmModule : Module() {
  private var ringtonePickerPromise: Promise? = null

  private fun diag(stage: String, details: String = "") {
    Log.i(
      "MathWakeDiag",
      "stage=$stage timestampMs=${System.currentTimeMillis()} pid=${android.os.Process.myPid()}$details",
    )
  }

  override fun definition() = ModuleDefinition {
    Name("MathWakeAlarm")

    AsyncFunction("scheduleAlarm") { alarmId: String, triggerAtMs: Double, deepLink: String, timeHHMM: String, daysCsv: String, isRecurring: Boolean, ringtoneUri: String, alarmTitle: String ->
      return@AsyncFunction scheduleAlarmImpl(alarmId, triggerAtMs.toLong(), deepLink, timeHHMM, daysCsv, isRecurring, ringtoneUri, alarmTitle, AlarmSnoozeCoordinator.DEFAULT_INTERVAL_MINUTES)
    }

    AsyncFunction("scheduleAlarmWithSnooze") { options: Map<String, Any?> ->
      val alarmId = options["alarmId"] as? String ?: return@AsyncFunction mapOf("scheduled" to false, "reason" to "invalid-alarm-id")
      val triggerAtMs = (options["triggerAtMs"] as? Number)?.toLong() ?: return@AsyncFunction mapOf("scheduled" to false, "reason" to "invalid-trigger")
      val deepLink = options["deepLink"] as? String ?: return@AsyncFunction mapOf("scheduled" to false, "reason" to "invalid-deep-link")
      val timeHHMM = options["timeHHMM"] as? String ?: return@AsyncFunction mapOf("scheduled" to false, "reason" to "invalid-time")
      val daysCsv = options["daysCsv"] as? String ?: return@AsyncFunction mapOf("scheduled" to false, "reason" to "invalid-days")
      val isRecurring = options["isRecurring"] as? Boolean ?: return@AsyncFunction mapOf("scheduled" to false, "reason" to "invalid-repeat")
      val ringtoneUri = options["ringtoneUri"] as? String ?: return@AsyncFunction mapOf("scheduled" to false, "reason" to "invalid-ringtone")
      val alarmTitle = options["alarmTitle"] as? String ?: "Alarm"
      val snoozeMinutes = (options["snoozeMinutes"] as? Number)?.toInt() ?: AlarmSnoozeCoordinator.DEFAULT_INTERVAL_MINUTES
      return@AsyncFunction scheduleAlarmImpl(alarmId, triggerAtMs, deepLink, timeHHMM, daysCsv, isRecurring, ringtoneUri, alarmTitle, snoozeMinutes)
    }

    AsyncFunction("cancelAlarm") { alarmId: String ->
      cancelAlarmImpl(alarmId)
    }

    AsyncFunction("updateAlarmSnoozeMinutes") { alarmId: String, snoozeMinutes: Int ->
      updateAlarmSnoozeMinutesImpl(alarmId, snoozeMinutes)
    }

    AsyncFunction("scheduleTimer") { deadlineAtMs: Double ->
      val context = appCtx() ?: return@AsyncFunction mapOf("scheduled" to false, "exact" to false, "reason" to "no-context")
      val result = scheduleTimerSystem(context, deadlineAtMs.toLong())
      mapOf(
        "scheduled" to result.scheduled,
        "exact" to result.exact,
        "triggerAtMs" to deadlineAtMs,
        "reason" to result.reason,
      )
    }

    AsyncFunction("cancelTimer") {
      appCtx()?.let { cancelTimerSystem(it) }
    }

    AsyncFunction("dismissNotification") { alarmId: String ->
      dismissNotificationImpl(alarmId)
    }

    // --- Looping foreground ringer control (started by the receiver) -------

    AsyncFunction("muteRing") { eventId: String, generation: String ->
      AlarmRingerService.mute(eventId, generation)
    }

    AsyncFunction("stopRing") { eventId: String, generation: String ->
      stopOccurrence(eventId, generation)
    }

    AsyncFunction("snoozeRing") { alarmId: String, eventId: String, generation: String, intervalMinutes: Int ->
      snoozeOccurrence(alarmId, eventId, generation, intervalMinutes)
    }

    AsyncFunction("isRinging") { eventId: String, generation: String ->
      AlarmRingerService.isRinging(eventId, generation)
    }

    AsyncFunction("getActiveAlarmId") {
      AlarmRingerService.activeAlarmId
    }

    AsyncFunction("hasFutureAlarmSchedule") { alarmId: String ->
      val context = appCtx() ?: return@AsyncFunction false
      readRecord(prefs(context), alarmId)?.triggerAtMs?.let { it > System.currentTimeMillis() } == true
    }

    AsyncFunction("hasOtherLiveAlarmOccurrence") { alarmId: String, eventId: String ->
      val context = appCtx() ?: return@AsyncFunction false
      AlarmEventLedger.all(sharedAlarmEventStore(prefs(context))).any {
        it.alarmId == alarmId && it.eventId != eventId && it.state in setOf(
          AlarmEventState.SCHEDULED, AlarmEventState.QUEUED, AlarmEventState.RINGING,
        )
      }
    }

    AsyncFunction("getActiveAlarmEvent") {
      val owner = AlarmRingerService.activeOwner() ?: return@AsyncFunction null
      mapOf("alarmId" to owner.alarmId, "eventId" to owner.eventId, "generation" to owner.generation)
    }

    AsyncFunction("getLiveAlarmIds") {
      val context = appCtx() ?: return@AsyncFunction emptyList<String>()
      AlarmEventLedger.all(sharedAlarmEventStore(prefs(context)))
        .filter { it.state == AlarmEventState.QUEUED || it.state == AlarmEventState.RINGING }
        .map { it.alarmId }
        .distinct()
    }

    AsyncFunction("ackPendingAlarm") { eventId: String, generation: String ->
      ackPendingImpl(eventId, generation)
    }

    AsyncFunction("dismissEventNotification") { eventId: String, generation: String ->
      dismissEventNotificationImpl(eventId, generation)
    }

    AsyncFunction("getAlarmEvent") { eventId: String ->
      val context = appCtx() ?: return@AsyncFunction null
      val event = AlarmEventLedger.get(sharedAlarmEventStore(prefs(context)), eventId)
        ?: return@AsyncFunction null
      event.toMap()
    }

    AsyncFunction("transitionAlarmEvent") { eventId: String, generation: String, targetState: String ->
      val context = appCtx() ?: return@AsyncFunction mapOf("result" to "missing")
      val target = runCatching { AlarmEventState.valueOf(targetState.uppercase()) }.getOrNull()
        ?: return@AsyncFunction mapOf("result" to "rejected")
      val store = sharedAlarmEventStore(prefs(context))
      val result = AlarmEventLedger.transition(store, eventId, generation, target)
      val current = AlarmEventLedger.get(store, eventId)
      mapOf("result" to result.name.lowercase(), "event" to current?.toMap())
    }

    // Android's built-in alarm ringtone picker returns a provider URI that
    // can be persisted with the alarm and consumed later by MediaPlayer.
    AsyncFunction("pickAlarmRingtone") { existingUri: String?, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(mapOf("cancelled" to true, "reason" to "no-activity"))
        return@AsyncFunction
      }
      try {
        ringtonePickerPromise?.resolve(mapOf("cancelled" to true, "reason" to "replaced"))
        ringtonePickerPromise = promise
        val intent = Intent(RingtoneManager.ACTION_RINGTONE_PICKER).apply {
          putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_ALARM)
          putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, "Pilih nada dering alarm")
          putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true)
          putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false)
          putExtra(
            RingtoneManager.EXTRA_RINGTONE_DEFAULT_URI,
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
          )
          existingUri?.takeIf { it.isNotBlank() }?.let {
            putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, Uri.parse(it))
          }
        }
        diag("picker.open")
        activity.startActivityForResult(intent, RINGTONE_PICKER_REQUEST)
      } catch (e: Exception) {
        ringtonePickerPromise = null
        diag("picker.open.failed", " reason=${e.javaClass.simpleName}")
        promise.resolve(mapOf("cancelled" to true, "reason" to "picker-unavailable"))
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("getDefaultAlarmRingtoneUri") {
      RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)?.toString()
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != RINGTONE_PICKER_REQUEST) return@OnActivityResult
      diag(
        "picker.result.received",
        " resultCode=${payload.resultCode} hasData=${payload.data != null}",
      )
      val promise = ringtonePickerPromise ?: return@OnActivityResult
      ringtonePickerPromise = null
      if (payload.resultCode != Activity.RESULT_OK) {
        diag("picker.result.resolved", " cancelled=true reason=cancelled")
        promise.resolve(mapOf("cancelled" to true, "reason" to "cancelled"))
        return@OnActivityResult
      }
       val uri = payload.data?.getParcelableExtra<Uri>(RingtoneManager.EXTRA_RINGTONE_PICKED_URI)
      if (uri == null || !isReadableRingtoneUri(uri)) {
        diag("picker.result.resolved", " cancelled=true reason=invalid-uri")
        promise.resolve(mapOf("cancelled" to true, "reason" to "invalid-uri"))
        return@OnActivityResult
      }
      // Provider URIs may otherwise be readable only while the picker result
      // activity is alive. Persist the grant when the provider supports it;
      // system ringtone providers may legitimately reject this call.
      val context = appCtx()
      try {
        val flags = payload.data?.flags ?: 0
        context?.contentResolver?.takePersistableUriPermission(
          uri,
          flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION),
        )
      } catch (_: Exception) {
      }
       val durableUri = try {
         copyRingtoneToPrivateStorage(context, uri) ?: uri
       } catch (e: Exception) {
         Log.w("MathWakeRingtoneTrace", "picker persistence failed reason=${e.javaClass.simpleName}; using provider URI")
         uri
       }
       Log.i("MathWakeRingtoneTrace", "picker selected scheme=${uri.scheme ?: "none"} durableScheme=${durableUri.scheme ?: "none"}")
       val title = try {
        if (context == null) null else RingtoneManager.getRingtone(context, uri)?.getTitle(context)
      } catch (_: Exception) {
        null
      }
      val displayName = title
        ?.takeIf { it.isNotBlank() && it != uri.toString() && !it.matches(Regex("[0-9a-fA-F]{20,}")) }
        ?: "Nada dering Android"
       diag(
         "picker.result.resolved",
         " cancelled=false uriScheme=${uri.scheme ?: "none"} durableUriScheme=${durableUri.scheme ?: "none"}",
       )
      promise.resolve(
        mapOf(
          "cancelled" to false,
           "uri" to durableUri.toString(),
          "name" to displayName,
        ),
      )
    }


    AsyncFunction("consumePendingAlarm") {
      return@AsyncFunction consumePendingImpl()
    }

    AsyncFunction("clearPendingAlarm") { alarmId: String ->
      clearPendingImpl(alarmId)
    }

    AsyncFunction("getStatus") {
      return@AsyncFunction statusImpl()
    }

    AsyncFunction("openExactAlarmSettings") {
      return@AsyncFunction openExactAlarmSettingsImpl()
    }

    AsyncFunction("openAppInfoSettings") {
      return@AsyncFunction openAppInfoSettingsImpl()
    }
  }

  private fun appCtx(): Context? = appContext.reactContext?.applicationContext

  private fun isReadableRingtoneUri(uri: Uri): Boolean {
    val context = appCtx() ?: return false
    return try {
      context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { true } ?: false
    } catch (_: Exception) {
      false
    }
  }

  /** Provider grants can disappear after the picker Activity closes. Keep a private copy. */
  private fun copyRingtoneToPrivateStorage(context: Context?, uri: Uri): Uri? {
    if (context == null || uri.scheme != "content") return uri
    val input = context.contentResolver.openInputStream(uri) ?: return null
    val dir = File(context.filesDir, "alarm-ringtones").apply { mkdirs() }
    val target = File(dir, "ringtone-${uri.toString().hashCode().toUInt().toString(16)}.tone")
    input.use { source ->
      FileOutputStream(target).use { output -> source.copyTo(output) }
    }
    return Uri.fromFile(target)
  }

  private fun scheduleAlarmImpl(
    alarmId: String,
    triggerAtMs: Long,
    deepLink: String,
    timeHHMM: String,
    daysCsv: String,
    isRecurring: Boolean,
    ringtoneUri: String,
    alarmTitle: String,
    snoozeMinutes: Int,
  ): Map<String, Any?> {
    if (snoozeMinutes !in AlarmSnoozeCoordinator.ALLOWED_INTERVALS) {
      return mapOf("scheduled" to false, "reason" to "invalid-snooze-interval")
    }
    val context = appCtx() ?: return mapOf("scheduled" to false, "reason" to "no-context")
    return try {
      val days = daysCsv.split(",").mapNotNull { it.trim().toIntOrNull() }.toSet()
      val store = prefs(context)
      val previous = readRecord(store, alarmId)
      val generation = previous
        ?.takeIf { it.triggerAtMs == triggerAtMs }
        ?.eventGeneration
        ?: UUID.randomUUID().toString()
      val record = AlarmRecord(
        alarmId = alarmId,
        triggerAtMs = triggerAtMs,
        deepLink = deepLink,
        timeHHMM = timeHHMM,
        days = days,
        isRecurring = isRecurring,
        ringtoneUri = ringtoneUri,
        title = alarmTitle.trim().take(40).ifBlank { "Alarm" },
        eventGeneration = generation,
        snoozeMinutes = snoozeMinutes,
      )
      if (previous != null) cancelSystemAlarm(context, alarmId)
      writeRecord(store, record)
      Log.i("MathWakeRingtoneTrace", "native-record alarmId=$alarmId scheme=${Uri.parse(ringtoneUri).scheme ?: "none"}")
      val exact = setExactAlarm(context, record)
      Log.i(TAG, "scheduled alarmId=$alarmId triggerAtMs=$triggerAtMs exact=$exact")
      mapOf("scheduled" to true, "exact" to exact, "triggerAtMs" to triggerAtMs.toDouble())
    } catch (e: Exception) {
      Log.e(TAG, "schedule failed alarmId=$alarmId: ${e.message}")
      mapOf("scheduled" to false, "reason" to (e.message ?: "unknown"))
    }
  }

  private fun cancelAlarmImpl(alarmId: String) {
    val context = appCtx() ?: return
    val store = prefs(context)
    val record = readRecord(store, alarmId)
    // This operation owns only the future schedule. It must never silence an
    // already-fired alarm: the active ringer is stopped only by the validated
    // challenge-success path (stopRing). Disabling/deleting/editing a schedule
    // is not a way around the challenge.
    try {
      cancelSystemAlarm(context, alarmId)
    } catch (_: Exception) {
    }
    if (record?.eventGeneration != null) {
      val eventId = AlarmEventLedger.eventId(alarmId, record.triggerAtMs, record.eventGeneration)
      val eventStore = sharedAlarmEventStore(store)
      AlarmEventLedger.ensureScheduled(
        eventStore,
        AlarmEventLedger.scheduled(alarmId, record.triggerAtMs, record.eventGeneration),
      )
      AlarmEventLedger.transition(
        eventStore, eventId, record.eventGeneration, AlarmEventState.STOPPED,
      )
    }
    try {
      deleteRecord(store, alarmId)
    } catch (_: Exception) {
    }
    dismissNotificationImpl(alarmId)
  }

  /** Updates only persisted alarm metadata; the AlarmManager trigger/identity is untouched. */
  private fun updateAlarmSnoozeMinutesImpl(alarmId: String, snoozeMinutes: Int): Boolean {
    if (alarmId.isBlank() || snoozeMinutes !in AlarmSnoozeCoordinator.ALLOWED_INTERVALS) return false
    val context = appCtx() ?: return false
    val store = prefs(context)
    val record = readRecord(store, alarmId) ?: return false
    return runCatching { writeRecord(store, record.copy(snoozeMinutes = snoozeMinutes), synchronous = true) }
      .getOrDefault(false)
  }

  private fun dismissNotificationImpl(alarmId: String) {
    val context = appCtx() ?: return
    try {
      // The foreground ringer owns its notification while the alarm is active;
      // do not cancel it from here. stopRing()/cancelAlarm() do the teardown,
      // otherwise an unsolved, still-ringing alarm would lose its notification.
      if (AlarmRingerService.isActive(alarmId)) return
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
      AlarmEventLedger.all(sharedAlarmEventStore(prefs(context)))
        .filter { it.alarmId == alarmId }
        .forEach { nm.cancel(it.eventId, NOTIFICATION_ID) }
      // Remove the pre-occurrence tagged notification if an older version left one.
      nm.cancel(alarmId, NOTIFICATION_ID)
    } catch (_: Exception) {
    }
  }

  private fun consumePendingImpl(): Map<String, Any?>? {
    val context = appCtx() ?: return null
    val store = prefs(context)
    migrateLegacyPending(store)
    PendingAlarmLedger.discardTerminalOrMissing(
      sharedPendingAlarmStore(store), sharedAlarmEventStore(store),
    )
    val pending = PendingAlarmLedger.peek(
      sharedPendingAlarmStore(store), AlarmEventLedger.all(sharedAlarmEventStore(store)),
    ) ?: return null
    val event = AlarmEventLedger.get(sharedAlarmEventStore(store), pending.eventId) ?: return null
    return event.toMap() + mapOf("firedAtMs" to pending.firedAtMs.toDouble())
  }

  private fun clearPendingImpl(alarmId: String) {
    val context = appCtx() ?: return
    val store = prefs(context)
    val raw = store.getString(KEY_PENDING, null) ?: return
    if (raw.startsWith("$alarmId|")) {
      store.edit().remove(KEY_PENDING).apply()
    }
  }

  private fun migrateLegacyPending(store: android.content.SharedPreferences) {
    val raw = store.getString(KEY_PENDING, null) ?: return
    val fields = raw.split('|')
    var safeToRemoveLegacy = true
    if (fields.size == 5) {
      val eventId = fields[2]
      val generation = fields[3]
      val event = AlarmEventLedger.get(sharedAlarmEventStore(store), eventId)
      if (event != null && event.alarmId == fields[0] && event.generation == generation) {
        val firedAt = fields[1].toLongOrNull()
        if (firedAt != null) safeToRemoveLegacy = PendingAlarmLedger.enqueue(
          sharedPendingAlarmStore(store), event.copy(state = AlarmEventState.RINGING), firedAt,
        )
      }
    }
    // Legacy marker is never returned as an alarmId-only actionable event.
    if (safeToRemoveLegacy) store.edit().remove(KEY_PENDING).commit()
  }

  private fun ackPendingImpl(eventId: String, generation: String): Boolean {
    if (eventId.isBlank() || generation.isBlank()) return false
    val context = appCtx() ?: return false
    val store = prefs(context)
    return PendingAlarmLedger.acknowledge(
      sharedPendingAlarmStore(store), sharedAlarmEventStore(store), eventId, generation,
    )
  }

  private fun dismissEventNotificationImpl(eventId: String, generation: String): Boolean {
    val context = appCtx() ?: return false
    val event = AlarmEventLedger.get(sharedAlarmEventStore(prefs(context)), eventId) ?: return false
    if (event.generation != generation) return false
    return try {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
      nm.cancel(eventId, NOTIFICATION_ID)
      true
    } catch (_: Exception) { false }
  }

  private fun stopOccurrence(eventId: String, generation: String): Boolean {
    return AlarmOccurrenceActionLock.withLock {
    if (eventId.isBlank() || generation.isBlank()) return@withLock false
    val context = appCtx() ?: return@withLock false
    val store = sharedAlarmEventStore(prefs(context))
    val event = AlarmEventLedger.get(store, eventId) ?: return@withLock false
    if (event.generation != generation || event.state != AlarmEventState.RINGING) return@withLock false
    val owner = AlarmRingerService.activeOwner()
    if (owner == null || owner.eventId != eventId || owner.generation != generation) return@withLock false
    val changed = AlarmEventLedger.transition(store, eventId, generation, AlarmEventState.COMPLETED)
    if (changed != AlarmEventTransitionResult.UPDATED && changed != AlarmEventTransitionResult.ALREADY_IN_STATE) return@withLock false
    val stopped = AlarmRingerService.stop(eventId, generation)
    if (!stopped) return@withLock false
    prefs(context).edit().remove(pendingEventKey(eventId)).commit()
    true
    }
  }

  private fun snoozeOccurrence(
    alarmId: String,
    eventId: String,
    generation: String,
    intervalMinutes: Int,
  ): Map<String, Any?> = AlarmOccurrenceActionLock.withLock {
    val context = appCtx() ?: return@withLock SnoozeOperationResult(false, reason = "no-context").toMap()
    snoozeRingingOccurrence(context, alarmId, eventId, generation, intervalMinutes).toMap()
  }

  private fun statusImpl(): Map<String, Any?> {
    val context = appCtx() ?: return mapOf("available" to false, "reason" to "no-context")
    val exact = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      try {
        val am = context.getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
        am.canScheduleExactAlarms()
      } catch (_: Exception) {
        false
      }
    } else {
      true
    }
    return mapOf(
      "available" to true,
      "canScheduleExactAlarms" to exact,
      "canUseFullScreenIntent" to canUseFullScreenIntent(context),
    )
  }

  private fun openExactAlarmSettingsImpl(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
    val context = appContext.reactContext ?: return false
    return try {
      val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
        data = Uri.parse("package:${context.packageName}")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
      true
    } catch (_: Exception) {
      false
    }
  }

  /**
   * Opens the system App info page for this app. Used as the grant path for
   * the full-screen intent permission (Android 14+), which exposes no
   * dedicated settings intent: the toggle lives in the app's system pages.
   * ACTION_APPLICATION_DETAILS_SETTINGS exists since API 9.
   */
  private fun openAppInfoSettingsImpl(): Boolean {
    val context = appContext.reactContext ?: return false
    return try {
      val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
        data = Uri.parse("package:${context.packageName}")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      context.startActivity(intent)
      true
    } catch (_: Exception) {
      false
    }
  }

  companion object {
    private const val RINGTONE_PICKER_REQUEST = 4107
    private const val TAG = "MathWakeAlarm"
  }
}
