package expo.modules.mathwakealarm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AlarmEventLedgerTest {
  @Test
  fun configuredAlarmSnoozeIntervalPersistsOnItsOccurrence() {
    val event = AlarmEventLedger.scheduled("alarm-configured", 1_800_000_000_000L, "generation", snoozeMinutes = 20)
    val restored = AlarmEventLedger.decode(AlarmEventLedger.encode(event))
    assertEquals(20, restored?.snoozeMinutes)
    assertEquals("alarm-configured", restored?.alarmId)
    assertFalse(restored?.isSnooze ?: true)
  }

  @Test
  fun occurrenceIdentitySeparatesRecurringEventsAndGenerations() {
    val first = AlarmEventLedger.scheduled("alarm:α", 1_800_000_000_000L, "generation-a")
    val nextOccurrence = AlarmEventLedger.scheduled("alarm:α", 1_800_000_300_000L, "generation-a")
    val nextGeneration = AlarmEventLedger.scheduled("alarm:α", 1_800_000_000_000L, "generation-b")

    assertNotEquals(first.eventId, nextOccurrence.eventId)
    assertNotEquals(first.eventId, nextGeneration.eventId)
    assertTrue(first.eventId.startsWith("mw1:616c61726d3aceb1:1800000000000:"))
  }

  @Test
  fun encodeDecodeRoundTripsAllPersistedFields() {
    val original = AlarmEventLedger.scheduled("alarm|α", 1_800_000_000_000L, "generation|a")
      .copy(state = AlarmEventState.RINGING, firedAtMs = 1_800_000_000_123L, sessionId = "session|α", revision = 4)

    assertEquals(original, AlarmEventLedger.decode(AlarmEventLedger.encode(original)))
  }

  @Test
  fun decodeRejectsMalformedOrUnsupportedRecords() {
    assertNull(AlarmEventLedger.decode(""))
    assertNull(AlarmEventLedger.decode("v2|00|1|00|SCHEDULED||00|0"))
    assertNull(AlarmEventLedger.decode("v1|0|1|00|SCHEDULED||00|0"))
    assertNull(AlarmEventLedger.decode("v1|00|0|00|SCHEDULED||00|0"))
    assertNull(AlarmEventLedger.decode("v1|00|1|00|UNKNOWN||00|0"))
  }

  @Test
  fun transitionsRequireMatchingGenerationAndLegalState() {
    val store = MemoryAlarmEventStore()
    val scheduled = AlarmEventLedger.scheduled("alarm-a", 1_800_000_000_000L, "generation-a")
    AlarmEventLedger.ensureScheduled(store, scheduled)

    assertEquals(
      AlarmEventTransitionResult.REJECTED,
      AlarmEventLedger.transition(store, scheduled.eventId, "old-generation", AlarmEventState.RINGING),
    )
    assertEquals(AlarmEventState.SCHEDULED, AlarmEventLedger.get(store, scheduled.eventId)?.state)
    assertEquals(
      AlarmEventTransitionResult.UPDATED,
      AlarmEventLedger.transition(store, scheduled.eventId, scheduled.generation, AlarmEventState.RINGING),
    )
    assertEquals(
      AlarmEventTransitionResult.REJECTED,
      AlarmEventLedger.transition(store, scheduled.eventId, scheduled.generation, AlarmEventState.SCHEDULED),
    )
    assertEquals(AlarmEventState.RINGING, AlarmEventLedger.get(store, scheduled.eventId)?.state)
  }

  @Test
  fun duplicateTransitionsAreIdempotentAndTerminalEventsStayTerminal() {
    val store = MemoryAlarmEventStore()
    val scheduled = AlarmEventLedger.scheduled("alarm-a", 1_800_000_000_000L, "generation-a")
    AlarmEventLedger.ensureScheduled(store, scheduled)

    assertEquals(
      AlarmEventTransitionResult.UPDATED,
      AlarmEventLedger.transition(store, scheduled.eventId, scheduled.generation, AlarmEventState.RINGING),
    )
    val ringing = AlarmEventLedger.get(store, scheduled.eventId)
    assertNotNull(ringing)
    assertEquals(
      AlarmEventTransitionResult.ALREADY_IN_STATE,
      AlarmEventLedger.transition(store, scheduled.eventId, scheduled.generation, AlarmEventState.RINGING),
    )
    assertEquals(ringing, AlarmEventLedger.get(store, scheduled.eventId))
    assertEquals(
      AlarmEventTransitionResult.UPDATED,
      AlarmEventLedger.transition(store, scheduled.eventId, scheduled.generation, AlarmEventState.COMPLETED),
    )
    assertEquals(
      AlarmEventTransitionResult.REJECTED,
      AlarmEventLedger.transition(store, scheduled.eventId, scheduled.generation, AlarmEventState.RINGING),
    )
  }

  @Test
  fun ensureScheduledIsIdempotentAndPreservesExistingEvent() {
    val backing = mutableMapOf<String, String>()
    val store = MemoryAlarmEventStore(backing)
    val scheduled = AlarmEventLedger.scheduled("alarm-a", 1_800_000_000_000L, "generation-a")

    assertEquals(scheduled, AlarmEventLedger.ensureScheduled(store, scheduled))
    assertEquals(
      AlarmEventTransitionResult.UPDATED,
      AlarmEventLedger.transition(store, scheduled.eventId, scheduled.generation, AlarmEventState.RINGING),
    )
    val writeCountAfterTransition = store.writeCount

    val reloadedStore = MemoryAlarmEventStore(backing)
    val existing = AlarmEventLedger.ensureScheduled(reloadedStore, scheduled)
    assertEquals(AlarmEventState.RINGING, existing?.state)
    assertEquals(0, reloadedStore.writeCount)
    assertEquals(writeCountAfterTransition, store.writeCount)
  }

  @Test
  fun missingAndFailedWritesDoNotReportSuccessfulTransitions() {
    val missingStore = MemoryAlarmEventStore()
    assertEquals(
      AlarmEventTransitionResult.MISSING,
      AlarmEventLedger.transition(missingStore, "missing", "generation-a", AlarmEventState.RINGING),
    )

    val failingStore = MemoryAlarmEventStore(failWrites = true)
    val scheduled = AlarmEventLedger.scheduled("alarm-a", 1_800_000_000_000L, "generation-a")
    assertNull(AlarmEventLedger.ensureScheduled(failingStore, scheduled))
    assertEquals(
      AlarmEventTransitionResult.MISSING,
      AlarmEventLedger.transition(failingStore, scheduled.eventId, scheduled.generation, AlarmEventState.RINGING),
    )

    val persistedStore = MemoryAlarmEventStore()
    AlarmEventLedger.ensureScheduled(persistedStore, scheduled)
    persistedStore.failWrites = true
    assertEquals(
      AlarmEventTransitionResult.REJECTED,
      AlarmEventLedger.transition(persistedStore, scheduled.eventId, scheduled.generation, AlarmEventState.RINGING),
    )
    assertEquals(AlarmEventState.SCHEDULED, AlarmEventLedger.get(persistedStore, scheduled.eventId)?.state)
  }

  @Test
  fun eventRecordsAreStoredIndependentlyPerOccurrence() {
    val store = MemoryAlarmEventStore()
    val first = AlarmEventLedger.scheduled("alarm-a", 1_800_000_000_000L, "generation-a")
    val second = AlarmEventLedger.scheduled("alarm-a", 1_800_000_300_000L, "generation-a")

    AlarmEventLedger.ensureScheduled(store, first)
    AlarmEventLedger.ensureScheduled(store, second)
    assertNotEquals(AlarmEventLedger.storageKey(first.eventId), AlarmEventLedger.storageKey(second.eventId))
    assertEquals(first.eventId, AlarmEventLedger.get(store, first.eventId)?.eventId)
    assertEquals(second.eventId, AlarmEventLedger.get(store, second.eventId)?.eventId)
    assertFalse(first.eventId == second.eventId)
  }

  private class MemoryAlarmEventStore(
    private val values: MutableMap<String, String> = mutableMapOf(),
    var failWrites: Boolean = false,
  ) : AlarmEventStore {
    var writeCount: Int = 0
      private set

    override fun read(eventId: String): String? = values[eventId]

    override fun all(): List<Pair<String, String>> = values.entries.map { it.key to it.value }

    override fun write(eventId: String, value: String): Boolean {
      writeCount += 1
      if (failWrites) return false
      values[eventId] = value
      return true
    }
  }
}
