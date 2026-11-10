package expo.modules.mathwakealarm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class AlarmEventQueueTest {
  @Test
  fun claimsEventsInTriggerOrderAndKeepsBQueuedWhileAIsActive() {
    val store = QueueStore()
    val a = event("alarm-a", 1_800_000_000_000L, "gen-a")
    val b = event("alarm-b", 1_800_000_120_000L, "gen-b")
    enqueue(store, b)
    enqueue(store, a)

    val first = AlarmEventQueue.claimNext(store, 1_800_000_000_000L)
    assertEquals(a.eventId, first?.eventId)
    assertEquals(AlarmEventState.QUEUED, AlarmEventLedger.get(store, b.eventId)?.state)
    assertNull(AlarmEventQueue.claimNext(store, 1_800_000_120_000L))

    AlarmEventLedger.transition(store, a.eventId, a.generation, AlarmEventState.COMPLETED)
    val second = AlarmEventQueue.claimNext(store, 1_800_000_120_000L)
    assertEquals(b.eventId, second?.eventId)
  }

  @Test
  fun equalTriggerTimesUseLexicalEventIdTieBreaker() {
    val store = QueueStore()
    val b = event("alarm-b", 1_800_000_000_000L, "gen-b")
    val a = event("alarm-a", 1_800_000_000_000L, "gen-a")
    enqueue(store, b)
    enqueue(store, a)

    assertEquals(minOf(a.eventId, b.eventId), AlarmEventQueue.claimNext(store, 1_800_000_000_000L)?.eventId)
  }

  @Test
  fun queuedOccurrenceIsValidImmediatelyBeforeTenMinuteBoundary() {
    val store = QueueStore()
    val event = event("alarm-a", 1_800_000_000_000L, "gen-a")
    enqueue(store, event)

    assertEquals(
      event.eventId,
      AlarmEventQueue.claimNext(store, event.triggerAtMs + AlarmEventQueue.MAX_QUEUE_AGE_MS - 1)?.eventId,
    )
  }

  @Test
  fun queuedOccurrenceDoesNotStartBeforeTriggerTime() {
    val store = QueueStore()
    val event = event("alarm-a", 1_800_000_000_000L, "gen-early")
    enqueue(store, event)
    assertNull(AlarmEventQueue.claimNext(store, event.triggerAtMs - 1))
    assertEquals(AlarmEventState.QUEUED, AlarmEventLedger.get(store, event.eventId)?.state)
    assertEquals(event.eventId, AlarmEventQueue.claimNext(store, event.triggerAtMs)?.eventId)
  }

  @Test
  fun queuedOccurrenceExpiresAtAndAfterTenMinuteBoundary() {
    for (offset in listOf(AlarmEventQueue.MAX_QUEUE_AGE_MS, AlarmEventQueue.MAX_QUEUE_AGE_MS + 1)) {
      val store = QueueStore()
      val event = event("alarm-a", 1_800_000_000_000L, "gen-$offset")
      enqueue(store, event)

      assertNull(AlarmEventQueue.claimNext(store, event.triggerAtMs + offset))
      assertEquals(AlarmEventState.EXPIRED, AlarmEventLedger.get(store, event.eventId)?.state)
      assertNull(AlarmEventQueue.claimNext(store, event.triggerAtMs + offset + 1))
    }
  }

  @Test
  fun expireMaintenanceMarksDueEventsAndIsIdempotent() {
    val store = QueueStore()
    val event = event("alarm-a", 1_800_000_000_000L, "gen-maintenance")
    enqueue(store, event)
    assertEquals(1, AlarmEventQueue.expireQueued(
      store, event.triggerAtMs + AlarmEventQueue.MAX_QUEUE_AGE_MS,
    ))
    assertEquals(AlarmEventState.EXPIRED, AlarmEventLedger.get(store, event.eventId)?.state)
    assertEquals(0, AlarmEventQueue.expireQueued(
      store, event.triggerAtMs + AlarmEventQueue.MAX_QUEUE_AGE_MS + 1,
    ))
  }

  @Test
  fun expiredAndTerminalEventsNeverReenterAfterRestoreOrDuplicateEnqueue() {
    val store = QueueStore()
    val expired = event("alarm-a", 1_800_000_000_000L, "gen-expired")
    val stopped = event("alarm-b", 1_800_000_120_000L, "gen-stopped")
    enqueue(store, expired)
    enqueue(store, stopped)
    AlarmEventLedger.transition(store, stopped.eventId, stopped.generation, AlarmEventState.STOPPED)

    AlarmEventQueue.claimNext(store, expired.triggerAtMs + AlarmEventQueue.MAX_QUEUE_AGE_MS)
    assertEquals(AlarmEventState.EXPIRED, AlarmEventLedger.get(store, expired.eventId)?.state)
    assertNull(AlarmEventQueue.enqueue(store, expired))
    assertNull(AlarmEventQueue.enqueue(store, stopped))
    assertNull(AlarmEventQueue.claimNext(store, stopped.triggerAtMs))
  }

  @Test
  fun restoreReturnsLostRingingEventToQueueAndClaimsOldest() {
    val store = QueueStore()
    val activeBeforeDeath = event("alarm-a", 1_800_000_000_000L, "gen-a")
    val waiting = event("alarm-b", 1_800_000_120_000L, "gen-b")
    AlarmEventLedger.ensureScheduled(store, activeBeforeDeath)
    AlarmEventLedger.transition(store, activeBeforeDeath.eventId, activeBeforeDeath.generation, AlarmEventState.RINGING)
    enqueue(store, waiting)

    val restoredStore = QueueStore()
    store.all().forEach { (id, raw) -> restoredStore.write(id, raw) }

    assertEquals(activeBeforeDeath.eventId, AlarmEventQueue.recoverAndClaimNext(restoredStore, 1_800_000_120_000L)?.eventId)
    assertEquals(AlarmEventState.QUEUED, AlarmEventLedger.get(restoredStore, waiting.eventId)?.state)
  }

  @Test
  fun duplicateAndConcurrentPumpClaimsOnlyOneOwner() {
    val store = QueueStore()
    val event = event("alarm-a", 1_800_000_000_000L, "gen-a")
    enqueue(store, event)
    val threads = 8
    val ready = CountDownLatch(threads)
    val start = CountDownLatch(1)
    val claimed = AtomicInteger(0)
    val workers = (0 until threads).map {
      Thread {
        ready.countDown()
        start.await(5, TimeUnit.SECONDS)
        if (AlarmEventQueue.claimNext(store, event.triggerAtMs) != null) claimed.incrementAndGet()
      }.apply { start() }
    }
    assertTrue(ready.await(5, TimeUnit.SECONDS))
    start.countDown()
    workers.forEach { it.join(5_000) }

    assertEquals(1, claimed.get())
    assertEquals(AlarmEventState.RINGING, AlarmEventLedger.get(store, event.eventId)?.state)
  }

  @Test
  fun writeFailureDoesNotReportQueueInsertionOrClaimSuccess() {
    val store = QueueStore()
    store.failWrites = true
    val event = event("alarm-a", 1_800_000_000_000L, "gen-a")

    assertNull(AlarmEventQueue.enqueue(store, event))
    assertNull(AlarmEventQueue.recoverAndClaimNext(store, event.triggerAtMs))
  }

  private fun event(alarmId: String, triggerAtMs: Long, generation: String) =
    AlarmEventLedger.scheduled(alarmId, triggerAtMs, generation, "mathwake://alarm-reminder", "tone://test")

  private fun enqueue(store: QueueStore, event: AlarmEvent) {
    assertEquals(AlarmEventState.QUEUED, AlarmEventQueue.enqueue(store, event)?.state)
  }

  private class QueueStore : AlarmEventStore {
    private val values = linkedMapOf<String, String>()
    var failWrites = false

    override fun read(eventId: String): String? = values[eventId]

    override fun write(eventId: String, value: String): Boolean {
      if (failWrites) return false
      values[eventId] = value
      return true
    }

    override fun all(): List<Pair<String, String>> = values.entries.map { it.key to it.value }
  }
}
