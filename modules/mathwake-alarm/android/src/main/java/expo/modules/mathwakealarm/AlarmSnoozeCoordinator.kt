package expo.modules.mathwakealarm

import java.util.UUID

internal data class SnoozeScheduleOutcome(
  val scheduled: Boolean,
  val exact: Boolean = false,
  val reason: String? = null,
)

internal data class SnoozeOperationResult(
  val success: Boolean,
  val alreadyScheduled: Boolean = false,
  val snoozeEvent: AlarmEvent? = null,
  val exact: Boolean = false,
  val reason: String? = null,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "success" to success,
    "alreadyScheduled" to alreadyScheduled,
    "eventId" to snoozeEvent?.eventId,
    "generation" to snoozeEvent?.generation,
    "triggerAtMs" to snoozeEvent?.triggerAtMs?.toDouble(),
    "exact" to exact,
    "reason" to reason,
  )
}

/** Serializes Snooze and normal successful-stop mutations for one occurrence. */
internal object AlarmOccurrenceActionLock {
  private val lock = Any()
  fun <T> withLock(action: () -> T): T = synchronized(lock, action)
}

/** Pure occurrence-level rules; Android scheduling and ringer teardown are injected. */
internal object AlarmSnoozeCoordinator {
  val ALLOWED_INTERVALS = setOf(5, 10, 15, 20, 30)
  const val DEFAULT_INTERVAL_MINUTES = 10

  fun snooze(
    store: AlarmEventStore,
    alarmId: String,
    eventId: String,
    generation: String,
    requestedIntervalMinutes: Int,
    nowMs: Long,
    activeOwner: RingerOwnership?,
    nextGeneration: () -> String = { UUID.randomUUID().toString() },
    schedule: (AlarmEvent) -> SnoozeScheduleOutcome,
    cancel: (AlarmEvent) -> Unit,
    stop: () -> Boolean,
  ): SnoozeOperationResult = AlarmOccurrenceActionLock.withLock {
    if (requestedIntervalMinutes !in ALLOWED_INTERVALS) return@withLock rejected("invalid-interval")
    if (alarmId.isBlank() || eventId.isBlank() || generation.isBlank()) return@withLock rejected("missing-identity")
    val source = AlarmEventLedger.get(store, eventId) ?: return@withLock rejected("event-missing")
    if (source.alarmId != alarmId || source.generation != generation) return@withLock rejected("identity-mismatch")

    // Repeated calls for the same source return its existing child and never
    // allocate a second PendingIntent or occurrence.
    source.snoozedToEventId?.let { childId ->
      val child = AlarmEventLedger.get(store, childId)
      if (source.state == AlarmEventState.SNOOZED && child != null && child.isSnooze &&
        child.sourceEventId == eventId && child.sourceGeneration == generation &&
        child.state in setOf(AlarmEventState.SCHEDULED, AlarmEventState.QUEUED, AlarmEventState.RINGING)
      ) return@withLock SnoozeOperationResult(true, alreadyScheduled = true, snoozeEvent = child)
      return@withLock rejected("stale-event")
    }

    if (source.state != AlarmEventState.RINGING) return@withLock rejected("event-not-ringing")
    if (activeOwner?.alarmId != alarmId || activeOwner.eventId != eventId || activeOwner.generation != generation) {
      return@withLock rejected("not-active-owner")
    }
    val triggerAtMs = runCatching { Math.addExact(nowMs, requestedIntervalMinutes * 60_000L) }
      .getOrElse { return@withLock rejected("trigger-overflow") }
    val newGeneration = nextGeneration()
    if (newGeneration.isBlank() || newGeneration == generation) return@withLock rejected("invalid-new-generation")
    val rootEventId = source.rootEventId ?: source.eventId
    val child = AlarmEventLedger.scheduled(
      alarmId = alarmId,
      triggerAtMs = triggerAtMs,
      generation = newGeneration,
      deepLink = source.deepLink,
      ringtoneUri = source.ringtoneUri,
      isSnooze = true,
      sourceEventId = source.eventId,
      sourceGeneration = source.generation,
      rootEventId = rootEventId,
      snoozeMinutes = requestedIntervalMinutes,
    )
    if (child.eventId == source.eventId || AlarmEventLedger.ensureScheduled(store, child) == null) {
      return@withLock rejected("event-persist-failed")
    }
    if (AlarmEventLedger.get(store, child.eventId) != child) return@withLock rejected("event-identity-collision")

    val scheduleResult = try { schedule(child) } catch (_: Throwable) { SnoozeScheduleOutcome(false, reason = "schedule-exception") }
    if (!scheduleResult.scheduled) {
      AlarmEventLedger.transition(store, child.eventId, child.generation, AlarmEventState.FAILED)
      return@withLock SnoozeOperationResult(false, reason = scheduleResult.reason ?: "schedule-failed")
    }

    val sourceTransition = AlarmEventLedger.transitionToSnoozed(store, eventId, generation, child.eventId)
    if (sourceTransition != AlarmEventTransitionResult.UPDATED) {
      runCatching { cancel(child) }
      AlarmEventLedger.transition(store, child.eventId, child.generation, AlarmEventState.STOPPED)
      return@withLock rejected("event-no-longer-ringing")
    }

    if (!runCatching(stop).getOrDefault(false)) {
      runCatching { cancel(child) }
      AlarmEventLedger.transition(store, child.eventId, child.generation, AlarmEventState.STOPPED)
      AlarmEventLedger.rollbackSnooze(store, eventId, generation, child.eventId)
      return@withLock rejected("ringer-stop-failed")
    }

    SnoozeOperationResult(true, snoozeEvent = AlarmEventLedger.get(store, child.eventId) ?: child, exact = scheduleResult.exact)
  }

  /** Source validation is repeated by receiver and boot recovery, never inferred from alarmId alone. */
  fun hasLiveSnoozeSource(store: AlarmEventStore, snooze: AlarmEvent): Boolean {
    if (!snooze.isSnooze) return false
    val sourceId = snooze.sourceEventId ?: return false
    val sourceGeneration = snooze.sourceGeneration ?: return false
    val source = AlarmEventLedger.get(store, sourceId) ?: return false
    return source.alarmId == snooze.alarmId && source.generation == sourceGeneration &&
      source.state == AlarmEventState.SNOOZED && source.snoozedToEventId == snooze.eventId
  }

  /** Scheduled Snooze events only; callers re-arm or immediately enqueue these on boot. */
  fun recoverableScheduledEvents(store: AlarmEventStore): List<AlarmEvent> =
    AlarmEventLedger.all(store).filter { it.state == AlarmEventState.SCHEDULED && it.isSnooze && hasLiveSnoozeSource(store, it) }

  private fun rejected(reason: String) = SnoozeOperationResult(false, reason = reason)
}
