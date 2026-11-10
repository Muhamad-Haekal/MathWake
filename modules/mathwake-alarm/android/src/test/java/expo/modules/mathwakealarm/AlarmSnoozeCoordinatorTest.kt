package expo.modules.mathwakealarm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class AlarmSnoozeCoordinatorTest {
  @Test
  fun snoozeTransitionsSourceAndCreatesIndependentChildIdentity() {
    val store = MemoryStore()
    val source = ringing(store)
    val result = runSnooze(store, source)
    val child = result.snoozeEvent

    assertTrue(result.success)
    assertNotNull(child)
    assertEquals(AlarmEventState.SNOOZED, AlarmEventLedger.get(store, source.eventId)?.state)
    assertEquals(child?.eventId, AlarmEventLedger.get(store, source.eventId)?.snoozedToEventId)
    assertNotEquals(source.eventId, child?.eventId)
    assertNotEquals(source.generation, child?.generation)
    assertEquals(source.alarmId, child?.alarmId)
    assertEquals(source.eventId, child?.sourceEventId)
    assertEquals(source.generation, child?.sourceGeneration)
    assertEquals(source.eventId, child?.rootEventId)
    assertEquals(10, child?.snoozeMinutes)
  }

  @Test
  fun rejectsWrongGenerationEventIdAlarmAndNonOwner() {
    val store = MemoryStore()
    val source = ringing(store)
    assertEquals("identity-mismatch", runSnooze(store, source, generation = "wrong").reason)
    assertEquals("event-missing", runSnooze(store, source, eventId = "wrong-event").reason)
    assertEquals("identity-mismatch", runSnooze(store, source, alarmId = "other-alarm").reason)
    assertEquals("not-active-owner", runSnooze(store, source, owner = null).reason)
    assertEquals(AlarmEventState.RINGING, AlarmEventLedger.get(store, source.eventId)?.state)
  }

  @Test
  fun stoppedOccurrenceCannotBeSnoozed() {
    val store = MemoryStore()
    val source = ringing(store)
    AlarmEventLedger.transition(store, source.eventId, source.generation, AlarmEventState.STOPPED)
    val result = runSnooze(store, source)
    assertFalse(result.success)
    assertEquals("event-not-ringing", result.reason)
    assertEquals(AlarmEventState.STOPPED, AlarmEventLedger.get(store, source.eventId)?.state)
    assertTrue(AlarmEventLedger.all(store).none { it.isSnooze })
  }

  @Test
  fun onlySupportedIntervalsAreAccepted() {
    for (interval in AlarmSnoozeCoordinator.ALLOWED_INTERVALS) {
      val store = MemoryStore()
      val source = ringing(store)
      val result = AlarmSnoozeCoordinator.snooze(
        store, source.alarmId, source.eventId, source.generation, interval, NOW,
        RingerOwnership(source.alarmId, source.eventId, source.generation, 1),
        nextGeneration = { "gen-$interval" }, schedule = { SnoozeScheduleOutcome(true) }, cancel = {}, stop = { true },
      )
      assertTrue("interval $interval", result.success)
      assertEquals(interval, result.snoozeEvent?.snoozeMinutes)
    }
    val store = MemoryStore()
    val source = ringing(store)
    val invalid = AlarmSnoozeCoordinator.snooze(
      store, source.alarmId, source.eventId, source.generation, 7, NOW,
      RingerOwnership(source.alarmId, source.eventId, source.generation, 1),
      schedule = { SnoozeScheduleOutcome(true) }, cancel = {}, stop = { true },
    )
    assertEquals("invalid-interval", invalid.reason)
  }

  @Test
  fun repeatedTapReturnsSameScheduledChildWithoutDuplicateScheduleOrStop() {
    val store = MemoryStore()
    val source = ringing(store)
    val schedules = AtomicInteger()
    val stops = AtomicInteger()
    val first = runSnooze(store, source, schedule = { schedules.incrementAndGet(); SnoozeScheduleOutcome(true, true) }, stop = { stops.incrementAndGet(); true })
    val second = runSnooze(store, source, schedule = { schedules.incrementAndGet(); SnoozeScheduleOutcome(true, true) }, stop = { stops.incrementAndGet(); true })

    assertTrue(first.success)
    assertTrue(second.success)
    assertTrue(second.alreadyScheduled)
    assertEquals(first.snoozeEvent?.eventId, second.snoozeEvent?.eventId)
    assertEquals(1, schedules.get())
    assertEquals(1, stops.get())
    assertEquals(2, AlarmEventLedger.all(store).size)
  }

  @Test
  fun mainRecurringScheduleRemainsUntouched() {
    val store = MemoryStore()
    val source = ringing(store)
    val nextRecurring = AlarmEventLedger.scheduled(source.alarmId, source.triggerAtMs + 86_400_000L, "next-day")
    AlarmEventLedger.ensureScheduled(store, nextRecurring)

    val result = runSnooze(store, source)

    assertTrue(result.success)
    assertEquals(nextRecurring, AlarmEventLedger.get(store, nextRecurring.eventId))
    assertEquals(3, AlarmEventLedger.all(store).size)
  }

  @Test
  fun queuedSnoozeWaitsForOtherOwnerAndDoesNotExpireAfterTenMinutes() {
    val store = MemoryStore()
    val source = ringing(store)
    val child = runSnooze(store, source).snoozeEvent!!
    assertEquals(AlarmEventState.QUEUED, AlarmEventQueue.enqueue(store, child)?.state)
    val other = AlarmEventLedger.scheduled("other-alarm", child.triggerAtMs, "other-gen")
    AlarmEventLedger.ensureScheduled(store, other)
    AlarmEventLedger.transition(store, other.eventId, other.generation, AlarmEventState.RINGING)
    assertNull(AlarmEventQueue.claimNext(store, child.triggerAtMs))
    assertNull(AlarmEventQueue.claimNext(store, child.triggerAtMs + AlarmEventQueue.MAX_QUEUE_AGE_MS + 1))
    assertEquals(AlarmEventState.QUEUED, AlarmEventLedger.get(store, child.eventId)?.state)

    AlarmEventLedger.transition(store, other.eventId, other.generation, AlarmEventState.COMPLETED)
    assertEquals(child.eventId, AlarmEventQueue.claimNext(store, child.triggerAtMs + AlarmEventQueue.MAX_QUEUE_AGE_MS + 2)?.eventId)
  }

  @Test
  fun twoEventsDueTogetherAreClaimedOneAtATime() {
    val store = MemoryStore()
    val source = ringing(store)
    val child = runSnooze(store, source).snoozeEvent!!
    val other = AlarmEventLedger.scheduled("alarm-b", child.triggerAtMs, "same-time")
    AlarmEventLedger.ensureScheduled(store, other)
    AlarmEventQueue.enqueue(store, child)
    AlarmEventQueue.enqueue(store, other)

    val first = AlarmEventQueue.claimNext(store, child.triggerAtMs)
    assertNotNull(first)
    assertNull(AlarmEventQueue.claimNext(store, child.triggerAtMs))
    AlarmEventLedger.transition(store, first!!.eventId, first.generation, AlarmEventState.COMPLETED)
    assertNotNull(AlarmEventQueue.claimNext(store, child.triggerAtMs))
  }

  @Test
  fun rebootRecoveryFindsOnlyScheduledSnoozeWithLiveSource() {
    val store = MemoryStore()
    val source = ringing(store)
    val child = runSnooze(store, source).snoozeEvent!!
    assertEquals(listOf(child), AlarmSnoozeCoordinator.recoverableScheduledEvents(store))
    val restored = MemoryStore(store.values.toMutableMap())
    assertEquals(listOf(child), AlarmSnoozeCoordinator.recoverableScheduledEvents(restored))
    AlarmEventLedger.transition(restored, source.eventId, source.generation, AlarmEventState.COMPLETED)
    assertTrue(AlarmSnoozeCoordinator.recoverableScheduledEvents(restored).isEmpty())
  }

  @Test
  fun ringingSnoozeOccurrenceCanCreateASeparateContinuation() {
    val store = MemoryStore()
    val firstSource = ringing(store)
    val first = runSnooze(store, firstSource).snoozeEvent!!
    AlarmEventQueue.enqueue(store, first)
    val ringingChild = AlarmEventQueue.claimNext(store, first.triggerAtMs)!!
    val continuation = AlarmSnoozeCoordinator.snooze(
      store, ringingChild.alarmId, ringingChild.eventId, ringingChild.generation, 5, NOW + 300_000,
      RingerOwnership(ringingChild.alarmId, ringingChild.eventId, ringingChild.generation, 2),
      nextGeneration = { "continuation-generation" }, schedule = { SnoozeScheduleOutcome(true) }, cancel = {}, stop = { true },
    )
    assertTrue(continuation.success)
    assertNotEquals(first.eventId, continuation.snoozeEvent?.eventId)
    assertEquals(firstSource.eventId, continuation.snoozeEvent?.rootEventId)
  }

  @Test
  fun failedRingerStopCancelsPreparedChildAndRestoresSource() {
    val store = MemoryStore()
    val source = ringing(store)
    var cancelled = false
    val result = runSnooze(store, source, cancel = { cancelled = true }, stop = { false })
    assertFalse(result.success)
    assertTrue(cancelled)
    assertEquals(AlarmEventState.RINGING, AlarmEventLedger.get(store, source.eventId)?.state)
    assertTrue(AlarmEventLedger.all(store).single { it.isSnooze }.state.let { it == AlarmEventState.STOPPED })
  }

  @Test
  fun failedSchedulingLeavesOriginalRingingAndDoesNotStopRinger() {
    val store = MemoryStore()
    val source = ringing(store)
    var stopped = false
    val result = runSnooze(
      store, source,
      schedule = { SnoozeScheduleOutcome(false, reason = "injected-failure") },
      stop = { stopped = true; true },
    )
    assertFalse(result.success)
    assertEquals("injected-failure", result.reason)
    assertFalse(stopped)
    assertEquals(AlarmEventState.RINGING, AlarmEventLedger.get(store, source.eventId)?.state)
    assertEquals(AlarmEventState.FAILED, AlarmEventLedger.all(store).single { it.isSnooze }.state)
  }

  @Test
  fun stopAndSnoozeAreSerializedAndOnlyOneCanOwnTheTransition() {
    val store = MemoryStore()
    val source = ringing(store)
    val ready = CountDownLatch(2)
    val start = CountDownLatch(1)
    val snoozeResult = arrayOfNulls<SnoozeOperationResult>(1)
    val snoozeThread = Thread {
      ready.countDown(); start.await(5, TimeUnit.SECONDS)
      snoozeResult[0] = runSnooze(store, source)
    }
    val stopThread = Thread {
      ready.countDown(); start.await(5, TimeUnit.SECONDS)
      AlarmOccurrenceActionLock.withLock {
        val current = AlarmEventLedger.get(store, source.eventId) ?: return@withLock
        if (current.state == AlarmEventState.RINGING) {
          AlarmEventLedger.transition(store, source.eventId, source.generation, AlarmEventState.COMPLETED)
        }
      }
    }
    snoozeThread.start(); stopThread.start()
    assertTrue(ready.await(5, TimeUnit.SECONDS)); start.countDown()
    snoozeThread.join(5_000); stopThread.join(5_000)
    val final = AlarmEventLedger.get(store, source.eventId)
    assertTrue(final?.state == AlarmEventState.SNOOZED || final?.state == AlarmEventState.COMPLETED)
    if (final?.state == AlarmEventState.SNOOZED) assertEquals(1, AlarmEventLedger.all(store).count { it.isSnooze && it.state == AlarmEventState.SCHEDULED })
    else assertTrue(AlarmEventLedger.all(store).none { it.isSnooze && it.state == AlarmEventState.SCHEDULED })
  }

  @Test
  fun snoozedSourceCannotReenterQueueOrCreateAnotherChild() {
    val store = MemoryStore()
    val source = ringing(store)
    val first = runSnooze(store, source)
    assertTrue(first.success)
    assertNull(AlarmEventQueue.enqueue(store, source))
    val second = runSnooze(store, source)
    assertTrue(second.alreadyScheduled)
    assertEquals(1, AlarmEventLedger.all(store).count { it.isSnooze })
  }

  private fun runSnooze(
    store: MemoryStore,
    source: AlarmEvent,
    alarmId: String = source.alarmId,
    eventId: String = source.eventId,
    generation: String = source.generation,
    owner: RingerOwnership? = RingerOwnership(source.alarmId, source.eventId, source.generation, 1),
    schedule: (AlarmEvent) -> SnoozeScheduleOutcome = { SnoozeScheduleOutcome(true, true) },
    cancel: (AlarmEvent) -> Unit = {},
    stop: () -> Boolean = { true },
  ) = AlarmSnoozeCoordinator.snooze(
    store, alarmId, eventId, generation, 10, NOW, owner,
    nextGeneration = { "new-generation-${source.eventId}" },
    schedule = schedule,
    cancel = cancel,
    stop = stop,
  )

  private fun ringing(store: MemoryStore): AlarmEvent {
    val source = AlarmEventLedger.scheduled("alarm-a", NOW, "source-generation", "mathwake://alarm-reminder", "tone://test")
    AlarmEventLedger.ensureScheduled(store, source)
    AlarmEventLedger.transition(store, source.eventId, source.generation, AlarmEventState.RINGING)
    return AlarmEventLedger.get(store, source.eventId)!!
  }

  private class MemoryStore(val values: MutableMap<String, String> = linkedMapOf()) : AlarmEventStore {
    override fun read(eventId: String): String? = values[eventId]
    override fun write(eventId: String, value: String): Boolean { values[eventId] = value; return true }
    override fun all(): List<Pair<String, String>> = values.map { it.key to it.value }
  }

  companion object { private const val NOW = 1_800_000_000_000L }
}
