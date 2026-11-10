package expo.modules.mathwakealarm

import java.nio.charset.StandardCharsets

/** Persisted identity and lifecycle for one scheduled alarm occurrence. */
internal enum class AlarmEventState {
  SCHEDULED,
  QUEUED,
  RINGING,
  SNOOZED,
  COMPLETED,
  STOPPED,
  EXPIRED,
  FAILED,
}

internal data class AlarmEvent(
  val alarmId: String,
  val eventId: String,
  val triggerAtMs: Long,
  val generation: String,
  val state: AlarmEventState,
  val firedAtMs: Long? = null,
  val sessionId: String = eventId,
  val revision: Int = 0,
  val deepLink: String = "",
  val ringtoneUri: String = "android-resource://alarm",
  val isSnooze: Boolean = false,
  val sourceEventId: String? = null,
  val sourceGeneration: String? = null,
  val rootEventId: String? = null,
  val snoozeMinutes: Int? = null,
  val snoozedToEventId: String? = null,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "alarmId" to alarmId,
    "eventId" to eventId,
    "triggerAtMs" to triggerAtMs.toDouble(),
    "generation" to generation,
    "state" to state.name.lowercase(),
    "firedAtMs" to firedAtMs?.toDouble(),
    "sessionId" to sessionId,
    "revision" to revision,
    "deepLink" to deepLink,
    "ringtoneUri" to ringtoneUri,
    "isSnooze" to isSnooze,
    "sourceEventId" to sourceEventId,
    "sourceGeneration" to sourceGeneration,
    "rootEventId" to rootEventId,
    "snoozeMinutes" to snoozeMinutes,
    "snoozedToEventId" to snoozedToEventId,
  )
}

/** Adapter keeps the lifecycle rules independent of Android storage APIs. */
internal interface AlarmEventStore {
  fun read(eventId: String): String?
  fun write(eventId: String, value: String): Boolean
  fun all(): List<Pair<String, String>>
}

internal enum class AlarmEventTransitionResult {
  UPDATED,
  ALREADY_IN_STATE,
  REJECTED,
  MISSING,
}

internal object AlarmEventLedger {
  private val lock = Any()

  /** Hex encoding is injective and delimiter-safe; no hash is used as identity. */
  fun eventId(alarmId: String, triggerAtMs: Long, generation: String): String =
    "mw1:${hex(alarmId)}:$triggerAtMs:$generation"

  fun scheduleIdentity(alarmId: String): String = "mathwake-alarm://schedule/${hex(alarmId)}"

  fun snoozeScheduleIdentity(eventId: String): String = "mathwake-alarm://snooze/${hex(eventId)}"

  fun notificationSnoozeIdentity(eventId: String): String = "mathwake-alarm://notification-snooze/${hex(eventId)}"

  fun storageKey(eventId: String): String = "event.$eventId"

  fun scheduled(
    alarmId: String,
    triggerAtMs: Long,
    generation: String,
    deepLink: String = "",
    ringtoneUri: String = "android-resource://alarm",
    isSnooze: Boolean = false,
    sourceEventId: String? = null,
    sourceGeneration: String? = null,
    rootEventId: String? = null,
    snoozeMinutes: Int? = null,
  ): AlarmEvent =
    AlarmEvent(
      alarmId = alarmId,
      eventId = eventId(alarmId, triggerAtMs, generation),
      triggerAtMs = triggerAtMs,
      generation = generation,
      state = AlarmEventState.SCHEDULED,
      deepLink = deepLink,
      ringtoneUri = ringtoneUri,
      isSnooze = isSnooze,
      sourceEventId = sourceEventId,
      sourceGeneration = sourceGeneration,
      rootEventId = rootEventId,
      snoozeMinutes = snoozeMinutes,
    )

  /** Never resets an existing event, including a terminal event. */
  fun ensureScheduled(store: AlarmEventStore, proposed: AlarmEvent): AlarmEvent? = synchronized(lock) {
    val current = read(store, proposed.eventId)
    if (current != null) return@synchronized current
    if (store.write(proposed.eventId, encode(proposed))) proposed else null
  }

  fun get(store: AlarmEventStore, eventId: String): AlarmEvent? = synchronized(lock) {
    read(store, eventId)
  }

  fun all(store: AlarmEventStore): List<AlarmEvent> = synchronized(lock) {
    store.all().mapNotNull { (eventId, raw) ->
      decode(raw)?.takeIf { it.eventId == eventId }
    }
  }

  fun transition(
    store: AlarmEventStore,
    eventId: String,
    generation: String,
    target: AlarmEventState,
    firedAtMs: Long? = null,
  ): AlarmEventTransitionResult = synchronized(lock) {
    val current = read(store, eventId) ?: return@synchronized AlarmEventTransitionResult.MISSING
    if (current.generation != generation) return@synchronized AlarmEventTransitionResult.REJECTED
    if (current.state == target) return@synchronized AlarmEventTransitionResult.ALREADY_IN_STATE
    if (target !in allowedTransitions(current.state)) return@synchronized AlarmEventTransitionResult.REJECTED
    val updated = current.copy(
      state = target,
      firedAtMs = firedAtMs ?: current.firedAtMs,
      revision = current.revision + 1,
    )
    if (store.write(eventId, encode(updated))) AlarmEventTransitionResult.UPDATED
    else AlarmEventTransitionResult.REJECTED
  }

  /** Commits the source lifecycle and child link in one ledger write. */
  fun transitionToSnoozed(
    store: AlarmEventStore,
    eventId: String,
    generation: String,
    snoozedToEventId: String,
  ): AlarmEventTransitionResult = synchronized(lock) {
    val current = read(store, eventId) ?: return@synchronized AlarmEventTransitionResult.MISSING
    if (current.generation != generation || current.state != AlarmEventState.RINGING) {
      return@synchronized AlarmEventTransitionResult.REJECTED
    }
    if (snoozedToEventId.isBlank()) return@synchronized AlarmEventTransitionResult.REJECTED
    val updated = current.copy(
      state = AlarmEventState.SNOOZED,
      snoozedToEventId = snoozedToEventId,
      revision = current.revision + 1,
    )
    if (store.write(eventId, encode(updated))) AlarmEventTransitionResult.UPDATED
    else AlarmEventTransitionResult.REJECTED
  }

  fun rollbackSnooze(
    store: AlarmEventStore,
    eventId: String,
    generation: String,
    childEventId: String,
  ): AlarmEventTransitionResult = synchronized(lock) {
    val current = read(store, eventId) ?: return@synchronized AlarmEventTransitionResult.MISSING
    if (current.generation != generation || current.state != AlarmEventState.SNOOZED || current.snoozedToEventId != childEventId) {
      return@synchronized AlarmEventTransitionResult.REJECTED
    }
    val updated = current.copy(state = AlarmEventState.RINGING, snoozedToEventId = null, revision = current.revision + 1)
    if (store.write(eventId, encode(updated))) AlarmEventTransitionResult.UPDATED
    else AlarmEventTransitionResult.REJECTED
  }

  fun encode(event: AlarmEvent): String = listOf(
    "v3",
    hex(event.alarmId),
    event.triggerAtMs.toString(),
    hex(event.generation),
    event.state.name,
    event.firedAtMs?.toString().orEmpty(),
    hex(event.sessionId),
    event.revision.toString(),
    hex(event.deepLink),
    hex(event.ringtoneUri),
    event.isSnooze.toString(),
    hex(event.sourceEventId.orEmpty()),
    hex(event.sourceGeneration.orEmpty()),
    hex(event.rootEventId.orEmpty()),
    event.snoozeMinutes?.toString().orEmpty(),
    hex(event.snoozedToEventId.orEmpty()),
  ).joinToString("|")

  fun decode(raw: String): AlarmEvent? {
    val fields = raw.split('|')
    val version = fields.firstOrNull() ?: return null
    if ((version == "v1" && fields.size != 8) || (version == "v2" && fields.size != 10) || (version == "v3" && fields.size != 16)) return null
    if (version != "v1" && version != "v2" && version != "v3") return null
    val alarmId = unhex(fields[1]) ?: return null
    val triggerAtMs = fields[2].toLongOrNull()?.takeIf { it > 0L } ?: return null
    val generation = unhex(fields[3])?.takeIf { it.isNotBlank() } ?: return null
    val state = runCatching { AlarmEventState.valueOf(fields[4]) }.getOrNull() ?: return null
    val firedAtMs = fields[5].takeIf { it.isNotEmpty() }?.toLongOrNull() ?:
      if (fields[5].isEmpty()) null else return null
    val sessionId = unhex(fields[6]) ?: return null
    val revision = fields[7].toIntOrNull()?.takeIf { it >= 0 } ?: return null
    val deepLink = if (version == "v2") unhex(fields[8]) ?: return null else ""
    val ringtoneUri = if (version == "v2") {
      unhex(fields[9])?.takeIf { it.isNotBlank() } ?: return null
    } else if (version == "v3") {
      unhex(fields[9])?.takeIf { it.isNotBlank() } ?: return null
    } else "android-resource://alarm"
    val isSnooze = if (version == "v3") fields[10].toBooleanStrictOrNull() ?: return null else false
    val sourceEventId = if (version == "v3") unhex(fields[11])?.ifEmpty { null } else null
    val sourceGeneration = if (version == "v3") unhex(fields[12])?.ifEmpty { null } else null
    val rootEventId = if (version == "v3") unhex(fields[13])?.ifEmpty { null } else null
    val snoozeMinutes = if (version == "v3") {
      if (fields[14].isEmpty()) null else fields[14].toIntOrNull() ?: return null
    } else null
    val snoozedToEventId = if (version == "v3") unhex(fields[15])?.ifEmpty { null } else null
    if (isSnooze && (sourceEventId.isNullOrBlank() || sourceGeneration.isNullOrBlank() || rootEventId.isNullOrBlank() || snoozeMinutes == null || snoozeMinutes !in AlarmSnoozeCoordinator.ALLOWED_INTERVALS)) return null
    val eventId = eventId(alarmId, triggerAtMs, generation)
    return AlarmEvent(
      alarmId, eventId, triggerAtMs, generation, state, firedAtMs, sessionId, revision, deepLink, ringtoneUri,
      isSnooze, sourceEventId, sourceGeneration, rootEventId, snoozeMinutes, snoozedToEventId,
    )
  }

  private fun read(store: AlarmEventStore, eventId: String): AlarmEvent? =
    store.read(eventId)?.let(::decode)?.takeIf { it.eventId == eventId }

  private fun allowedTransitions(from: AlarmEventState): Set<AlarmEventState> = when (from) {
    AlarmEventState.SCHEDULED -> setOf(AlarmEventState.QUEUED, AlarmEventState.RINGING, AlarmEventState.STOPPED, AlarmEventState.EXPIRED, AlarmEventState.FAILED)
    AlarmEventState.QUEUED -> setOf(AlarmEventState.RINGING, AlarmEventState.STOPPED, AlarmEventState.EXPIRED, AlarmEventState.FAILED)
    AlarmEventState.RINGING -> setOf(AlarmEventState.QUEUED, AlarmEventState.SNOOZED, AlarmEventState.COMPLETED, AlarmEventState.STOPPED, AlarmEventState.EXPIRED, AlarmEventState.FAILED)
    AlarmEventState.SNOOZED -> setOf(AlarmEventState.RINGING, AlarmEventState.COMPLETED, AlarmEventState.STOPPED, AlarmEventState.EXPIRED)
    AlarmEventState.COMPLETED, AlarmEventState.STOPPED, AlarmEventState.EXPIRED, AlarmEventState.FAILED -> emptySet()
  }

  private fun hex(value: String): String = value.toByteArray(StandardCharsets.UTF_8)
    .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }

  private fun unhex(value: String): String? {
    if (value.length % 2 != 0) return null
    return try {
      val bytes = ByteArray(value.length / 2) { index ->
        value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
      }
      String(bytes, StandardCharsets.UTF_8)
    } catch (_: Exception) {
      null
    }
  }
}
