package expo.modules.mathwakealarm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class AlarmRecordTitleTest {
  @Test fun titleIsNormalizedAndBoundToAlarmRecord() {
    val first = AlarmRecord("one", 1L, "", "06:00", emptySet(), false, title = "Kuliah")
    val second = AlarmRecord("two", 2L, "", "07:00", emptySet(), false, title = "Kerja")
    assertEquals("Kuliah", normalizeAlarmTitle(first.title))
    assertEquals("Kerja", normalizeAlarmTitle(second.title))
    assertNotEquals(first.title, second.title)
    assertEquals("Alarm", normalizeAlarmTitle(null))
    assertEquals("Alarm", normalizeAlarmTitle("  "))
    assertEquals(40, normalizeAlarmTitle("x".repeat(60)).length)
  }
}
