package expo.modules.mathwakealarm

/** Durable FIFO rules for fired occurrences. Ordering ties use eventId lexical order. */
internal object AlarmEventQueue {
  const val MAX_QUEUE_AGE_MS = 10 * 60 * 1000L
  private val lock = Any()

  /** Stores the occurrence first; a duplicate fire never resets an existing lifecycle. */
  fun enqueue(store: AlarmEventStore, proposed: AlarmEvent): AlarmEvent? = synchronized(lock) {
    val current = AlarmEventLedger.ensureScheduled(store, proposed) ?: return@synchronized null
    when (current.state) {
      AlarmEventState.SCHEDULED -> {
        if (AlarmEventLedger.transition(
            store, current.eventId, current.generation, AlarmEventState.QUEUED, proposed.firedAtMs,
          ) == AlarmEventTransitionResult.UPDATED
        ) AlarmEventLedger.get(store, current.eventId) else null
      }
      AlarmEventState.QUEUED, AlarmEventState.RINGING -> current
      AlarmEventState.SNOOZED,
      AlarmEventState.COMPLETED,
      AlarmEventState.STOPPED,
      AlarmEventState.EXPIRED,
      AlarmEventState.FAILED -> null
    }
  }

  /** Claims the next item only when no event is already marked RINGING. */
  fun claimNext(store: AlarmEventStore, nowMs: Long): AlarmEvent? = synchronized(lock) {
    if (AlarmEventLedger.all(store).any { it.state == AlarmEventState.RINGING }) return@synchronized null
    claimQueued(store, nowMs)
  }

  /**
   * Recovers a process-lost RINGING event, then claims the oldest valid queued
   * event. Call only once when restoring a process/service after restart or boot.
   */
  fun recoverAndClaimNext(store: AlarmEventStore, nowMs: Long): AlarmEvent? = synchronized(lock) {
    val events = AlarmEventLedger.all(store)
    for (event in events.filter { it.state == AlarmEventState.RINGING }) {
      if (isExpired(event, nowMs)) {
        AlarmEventLedger.transition(store, event.eventId, event.generation, AlarmEventState.EXPIRED)
      } else {
        AlarmEventLedger.transition(store, event.eventId, event.generation, AlarmEventState.QUEUED)
      }
    }

    claimQueued(store, nowMs)
  }

  private fun claimQueued(store: AlarmEventStore, nowMs: Long): AlarmEvent? {
    val queued = AlarmEventLedger.all(store)
      .filter { it.state == AlarmEventState.QUEUED }
      .sortedWith(compareBy<AlarmEvent> { it.triggerAtMs }.thenBy { it.eventId })

    for (event in queued) {
      if (nowMs < event.triggerAtMs) return null
      if (isExpired(event, nowMs)) {
        AlarmEventLedger.transition(store, event.eventId, event.generation, AlarmEventState.EXPIRED)
        continue
      }
      val result = AlarmEventLedger.transition(
        store, event.eventId, event.generation, AlarmEventState.RINGING,
      )
      if (result == AlarmEventTransitionResult.UPDATED) {
        return AlarmEventLedger.get(store, event.eventId)
      }
    }
    return null
  }

  fun expireQueued(store: AlarmEventStore, nowMs: Long): Int = synchronized(lock) {
    var expired = 0
    for (event in AlarmEventLedger.all(store).filter { it.state == AlarmEventState.QUEUED }) {
      if (isExpired(event, nowMs) && AlarmEventLedger.transition(
          store, event.eventId, event.generation, AlarmEventState.EXPIRED,
        ) == AlarmEventTransitionResult.UPDATED
      ) expired += 1
    }
    expired
  }

  fun isExpired(event: AlarmEvent, nowMs: Long): Boolean =
    !event.isSnooze && nowMs >= event.triggerAtMs && nowMs - event.triggerAtMs >= MAX_QUEUE_AGE_MS
}
