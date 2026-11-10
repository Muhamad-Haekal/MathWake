package expo.modules.mathwakealarm

/** Identifies one in-process owner of the native ringer resources. */
internal data class RingerOwnership(
  val alarmId: String,
  val eventId: String,
  val generation: String,
  val token: Long,
)

/**
 * Serializes ownership changes with callback effects. Callbacks must execute
 * resource changes inside [runIfCurrent], which checks the lease at execution
 * time and keeps ownership stable until the effect completes.
 */
internal class RingerOwnershipCoordinator {
  private val lock = Any()
  private var current: RingerOwnership? = null
  private var nextToken = 0L

  fun claim(alarmId: String, eventId: String, generation: String): RingerOwnership = synchronized(lock) {
    val existing = current
    if (existing?.alarmId == alarmId && existing.eventId == eventId && existing.generation == generation) {
      return@synchronized existing
    }
    val replacement = RingerOwnership(alarmId, eventId, generation, ++nextToken)
    current = replacement
    replacement
  }

  fun current(): RingerOwnership? = synchronized(lock) { current }

  fun isCurrent(owner: RingerOwnership): Boolean = synchronized(lock) { current == owner }

  fun runIfCurrent(owner: RingerOwnership, effect: () -> Unit): Boolean = synchronized(lock) {
    if (current != owner) return@synchronized false
    effect()
    true
  }

  fun <T> readIfCurrent(owner: RingerOwnership, read: () -> T): T? = synchronized(lock) {
    if (current != owner) return@synchronized null
    read()
  }

  fun release(owner: RingerOwnership): Boolean = synchronized(lock) {
    if (current != owner) return@synchronized false
    current = null
    true
  }
}
