package expo.modules.mathwakealarm

/** Durable acknowledgement queue. Reads are repeatable until an exact ack succeeds. */
internal data class PendingAlarmEvent(
  val alarmId: String,
  val eventId: String,
  val generation: String,
  val triggerAtMs: Long,
  val firedAtMs: Long,
)

internal interface PendingAlarmStore {
  fun read(eventId: String): String?
  fun write(eventId: String, encoded: String): Boolean
  fun remove(eventId: String): Boolean
  fun all(): List<Pair<String, String>>
}

internal object PendingAlarmLedger {
  private val lock = Any()

  fun enqueue(store: PendingAlarmStore, event: AlarmEvent, firedAtMs: Long): Boolean = synchronized(lock) {
    if (event.state != AlarmEventState.QUEUED && event.state != AlarmEventState.RINGING) return@synchronized false
    val current = store.read(event.eventId)?.let(::decode)
    if (current != null) return@synchronized current == PendingAlarmEvent(
      event.alarmId, event.eventId, event.generation, event.triggerAtMs, current.firedAtMs,
    )
    store.write(event.eventId, encode(PendingAlarmEvent(
      event.alarmId, event.eventId, event.generation, event.triggerAtMs, firedAtMs,
    )))
  }

  fun peek(store: PendingAlarmStore, events: List<AlarmEvent>): PendingAlarmEvent? = synchronized(lock) {
    val valid = events.filter { it.state == AlarmEventState.RINGING }
      .sortedWith(compareBy<AlarmEvent> { it.triggerAtMs }.thenBy { it.eventId })
    for (event in valid) {
      val pending = store.read(event.eventId)?.let(::decode) ?: continue
      if (pending.eventId == event.eventId && pending.alarmId == event.alarmId &&
        pending.generation == event.generation && pending.triggerAtMs == event.triggerAtMs
      ) return@synchronized pending
    }
    null
  }

  fun acknowledge(store: PendingAlarmStore, ledger: AlarmEventStore, eventId: String, generation: String): Boolean = synchronized(lock) {
    if (eventId.isBlank() || generation.isBlank()) return@synchronized false
    val event = AlarmEventLedger.get(ledger, eventId) ?: return@synchronized false
    if (event.generation != generation || event.state != AlarmEventState.RINGING) return@synchronized false
    val pending = store.read(eventId)?.let(::decode) ?: return@synchronized false
    if (pending.generation != generation || pending.eventId != eventId) return@synchronized false
    store.remove(eventId)
  }

  /** Prunes only markers whose authoritative ledger event is terminal or missing. */
  fun discardTerminalOrMissing(store: PendingAlarmStore, ledger: AlarmEventStore): Int = synchronized(lock) {
    var removed = 0
    for ((eventId, raw) in store.all()) {
      val pending = decode(raw)
      val event = pending?.let { AlarmEventLedger.get(ledger, it.eventId) }
      if (pending == null || pending.eventId != eventId || event == null ||
        event.generation != pending.generation || event.state in setOf(
          AlarmEventState.SNOOZED, AlarmEventState.COMPLETED, AlarmEventState.STOPPED, AlarmEventState.EXPIRED, AlarmEventState.FAILED,
        )
      ) if (store.remove(eventId)) removed += 1
    }
    removed
  }

  fun encode(event: PendingAlarmEvent): String = listOf(
    "p1", hex(event.alarmId), hex(event.eventId), hex(event.generation),
    event.triggerAtMs.toString(), event.firedAtMs.toString(),
  ).joinToString("|")

  fun decode(raw: String): PendingAlarmEvent? {
    val fields = raw.split('|')
    if (fields.size != 6 || fields[0] != "p1") return null
    val alarmId = unhex(fields[1])?.takeIf(String::isNotBlank) ?: return null
    val eventId = unhex(fields[2])?.takeIf(String::isNotBlank) ?: return null
    val generation = unhex(fields[3])?.takeIf(String::isNotBlank) ?: return null
    val trigger = fields[4].toLongOrNull()?.takeIf { it > 0L } ?: return null
    val fired = fields[5].toLongOrNull()?.takeIf { it > 0L } ?: return null
    return PendingAlarmEvent(alarmId, eventId, generation, trigger, fired)
  }

  private fun hex(value: String) = value.encodeToByteArray().joinToString("") { "%02x".format(it.toInt() and 0xff) }
  private fun unhex(value: String): String? {
    if (value.length % 2 != 0) return null
    return runCatching {
      ByteArray(value.length / 2) { i -> value.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
        .toString(Charsets.UTF_8)
    }.getOrNull()
  }
}
