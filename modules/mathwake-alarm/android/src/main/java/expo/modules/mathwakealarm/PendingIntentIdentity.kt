package expo.modules.mathwakealarm

internal interface PendingIntentCodeStore {
  fun read(eventId: String): Int?
  fun allCodes(): Set<Int>
  fun nextCode(): Int
  fun writeMappingAndNext(eventId: String, code: Int): Boolean
}

/** Persistent monotonic allocator; event identifiers never reduce to hash-derived codes. */
internal object PendingIntentIdentity {
  private val lock = Any()

  fun requestCode(store: PendingIntentCodeStore, eventId: String): Int = synchronized(lock) {
    require(eventId.isNotBlank()) { "pending-intent-event-id-required" }
    store.read(eventId)?.takeIf { it > 0 }?.let { return@synchronized it }
    var candidate = store.nextCode()
    val used = store.allCodes()
    while (candidate > 0 && candidate in used) candidate++
    require(candidate > 0 && candidate < Int.MAX_VALUE) { "pending-intent-code-space-exhausted" }
    check(store.writeMappingAndNext(eventId, candidate)) { "pending-intent-identity-persist-failed" }
    candidate
  }
}
