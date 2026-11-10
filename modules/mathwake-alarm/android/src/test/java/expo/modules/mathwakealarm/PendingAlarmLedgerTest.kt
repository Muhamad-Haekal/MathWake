package expo.modules.mathwakealarm

import org.junit.Assert.*
import org.junit.Test

class PendingAlarmLedgerTest {
  private class MemoryPendingStore : PendingAlarmStore {
    val rows = linkedMapOf<String, String>()
    var failWrites = false
    override fun read(eventId: String) = rows[eventId]
    override fun write(eventId: String, encoded: String): Boolean {
      if (failWrites) return false
      rows[eventId] = encoded
      return true
    }
    override fun remove(eventId: String) = rows.remove(eventId) != null
    override fun all() = rows.toList()
  }

  private class MemoryEventStore : AlarmEventStore {
    val rows = linkedMapOf<String, String>()
    override fun read(eventId: String) = rows[eventId]
    override fun write(eventId: String, value: String): Boolean { rows[eventId] = value; return true }
    override fun all() = rows.toList()
  }

  private fun queued(store: MemoryEventStore, id: String, trigger: Long, gen: String): AlarmEvent {
    val event = AlarmEventLedger.scheduled(id, trigger, gen)
    AlarmEventLedger.ensureScheduled(store, event)
    AlarmEventQueue.enqueue(store, event.copy(firedAtMs = trigger + 1))
    return AlarmEventLedger.get(store, event.eventId)!!
  }

  @Test fun `pending events with same alarm keep separate occurrence identity`() {
    val events = MemoryEventStore()
    val a = queued(events, "same", 1000, "a")
    val b = queued(events, "same", 2000, "b")
    val pending = MemoryPendingStore()
    val aRinging = AlarmEventQueue.claimNext(events, 1001)!!
    val bQueued = AlarmEventLedger.get(events, b.eventId)!!
    assertTrue(PendingAlarmLedger.enqueue(pending, aRinging, 1002))
    assertTrue(PendingAlarmLedger.enqueue(pending, bQueued, 2001))
    assertEquals(2, pending.rows.size)
    assertNotEquals(a.eventId, b.eventId)
  }

  @Test fun `peek is idempotent and acknowledges only exact event`() {
    val events = MemoryEventStore()
    val a = queued(events, "same", 1000, "a")
    val b = queued(events, "same", 2000, "b")
    val ringingA = AlarmEventQueue.claimNext(events, 1001)!!
    val pending = MemoryPendingStore()
    PendingAlarmLedger.enqueue(pending, ringingA, 1002)
    // B remains queued until A releases ownership; durable marker is independent.
    assertTrue(PendingAlarmLedger.enqueue(pending, b, 2001))
    assertEquals(a.eventId, PendingAlarmLedger.peek(pending, AlarmEventLedger.all(events))?.eventId)
    assertEquals(a.eventId, PendingAlarmLedger.peek(pending, AlarmEventLedger.all(events))?.eventId)
    assertFalse(PendingAlarmLedger.acknowledge(pending, events, a.eventId, "wrong"))
    assertTrue(PendingAlarmLedger.acknowledge(pending, events, a.eventId, "a"))
    assertTrue(pending.rows.containsKey(b.eventId))
  }

  @Test fun `corrupt identity and persistence failure are rejected`() {
    val events = MemoryEventStore()
    val event = queued(events, "alarm", 1000, "g")
    val pending = MemoryPendingStore().apply { failWrites = true }
    val ringing = AlarmEventQueue.claimNext(events, 1001)!!
    assertFalse(PendingAlarmLedger.enqueue(pending, ringing, 1002))
    pending.failWrites = false
    pending.rows[event.eventId] = "bad|record"
    assertNull(PendingAlarmLedger.peek(pending, AlarmEventLedger.all(events)))
    assertFalse(PendingAlarmLedger.acknowledge(pending, events, event.eventId, "g"))
  }

  @Test fun `snoozed source pending marker is pruned and cannot be replayed`() {
    val events = MemoryEventStore()
    val source = queued(events, "alarm", 1000, "g")
    val ringing = AlarmEventQueue.claimNext(events, 1001)!!
    val pending = MemoryPendingStore()
    assertTrue(PendingAlarmLedger.enqueue(pending, ringing, 1002))
    assertEquals(AlarmEventTransitionResult.UPDATED,
      AlarmEventLedger.transitionToSnoozed(events, source.eventId, source.generation, "child-event"))
    assertEquals(1, PendingAlarmLedger.discardTerminalOrMissing(pending, events))
    assertNull(PendingAlarmLedger.peek(pending, AlarmEventLedger.all(events)))
  }
}
