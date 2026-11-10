package expo.modules.mathwakealarm

import org.junit.Assert.*
import org.junit.Test

class PendingIntentIdentityTest {
  private class MemoryCodeStore : PendingIntentCodeStore {
    val values = linkedMapOf<String, Int>()
    var next = 20_000
    var fail = false
    override fun read(eventId: String) = values[eventId]
    override fun allCodes() = values.values.toSet()
    override fun nextCode() = next
    override fun writeMappingAndNext(eventId: String, code: Int): Boolean {
      if (fail) return false
      values[eventId] = code
      next = code + 1
      return true
    }
  }

  @Test fun `distinct occurrences get stable distinct request codes across restore`() {
    val store = MemoryCodeStore()
    val a = PendingIntentIdentity.requestCode(store, "event-a")
    val b = PendingIntentIdentity.requestCode(store, "event-b")
    assertNotEquals(a, b)
    assertEquals(a, PendingIntentIdentity.requestCode(store, "event-a"))
  }

  @Test fun `allocator avoids stored collision and fails closed when persistence fails`() {
    val store = MemoryCodeStore().apply { values["old"] = 20_000 }
    assertEquals(20_001, PendingIntentIdentity.requestCode(store, "new"))
    store.fail = true
    try {
      PendingIntentIdentity.requestCode(store, "unpersisted")
      fail("expected failed persistence to reject allocation")
    } catch (expected: IllegalStateException) {
      assertEquals(null, store.read("unpersisted"))
    }
  }

  @Test fun `snooze alarm identity is occurrence scoped and separate from main alarm identity`() {
    val sourceEvent = AlarmEventLedger.eventId("alarm-a", 1_800_000_000_000L, "source")
    val snoozeA = AlarmEventLedger.eventId("alarm-a", 1_800_000_300_000L, "snooze-a")
    val snoozeB = AlarmEventLedger.eventId("alarm-a", 1_800_000_600_000L, "snooze-b")
    assertNotEquals(AlarmEventLedger.scheduleIdentity("alarm-a"), AlarmEventLedger.snoozeScheduleIdentity(snoozeA))
    assertNotEquals(AlarmEventLedger.snoozeScheduleIdentity(snoozeA), AlarmEventLedger.snoozeScheduleIdentity(snoozeB))
    assertNotEquals(AlarmEventLedger.snoozeScheduleIdentity(sourceEvent), AlarmEventLedger.snoozeScheduleIdentity(snoozeA))
  }

  @Test fun `notification snooze action identity is separate and occurrence scoped`() {
    val sourceA = AlarmEventLedger.eventId("alarm-a", 1_800_000_000_000L, "source-a")
    val sourceB = AlarmEventLedger.eventId("alarm-b", 1_800_000_000_000L, "source-b")
    assertNotEquals(AlarmEventLedger.scheduleIdentity("alarm-a"), AlarmEventLedger.notificationSnoozeIdentity(sourceA))
    assertNotEquals(AlarmEventLedger.snoozeScheduleIdentity(sourceA), AlarmEventLedger.notificationSnoozeIdentity(sourceA))
    assertNotEquals(AlarmEventLedger.notificationSnoozeIdentity(sourceA), AlarmEventLedger.notificationSnoozeIdentity(sourceB))
    val store = MemoryCodeStore()
    val challengeAction = PendingIntentIdentity.requestCode(store, sourceA)
    val snoozeAction = PendingIntentIdentity.requestCode(store, "notification-snooze:$sourceA")
    assertNotEquals(challengeAction, snoozeAction)
  }
}
