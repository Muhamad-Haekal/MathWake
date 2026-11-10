package expo.modules.mathwakealarm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class RingerOwnershipCoordinatorTest {
  @Test
  fun delayedStopFromAIsRejectedAfterBClaimsOwnership() {
    val coordinator = RingerOwnershipCoordinator()
    val a = coordinator.claim("alarm-a", "event-a", "generation-a")
    var stopCount = 0

    val delayedStop = { coordinator.runIfCurrent(a) { stopCount += 1 } }
    val b = coordinator.claim("alarm-b", "event-b", "generation-b")

    assertFalse(delayedStop())
    assertEquals(0, stopCount)
    assertTrue(coordinator.isCurrent(b))
  }

  @Test
  fun delayedMuteFromAIsRejectedAfterBClaimsOwnership() {
    val coordinator = RingerOwnershipCoordinator()
    val a = coordinator.claim("alarm-a", "event-a", "generation-a")
    var muteCount = 0
    val delayedMute = { coordinator.runIfCurrent(a) { muteCount += 1 } }
    val b = coordinator.claim("alarm-b", "event-b", "generation-b")

    assertFalse(delayedMute())
    assertEquals(0, muteCount)
    assertTrue(coordinator.isCurrent(b))
  }

  @Test
  fun staleMediaErrorCannotCleanResourcesOwnedByB() {
    val coordinator = RingerOwnershipCoordinator()
    val a = coordinator.claim("alarm-a", "event-a", "generation-a")
    val resources = FakeResources(a)
    val b = coordinator.claim("alarm-b", "event-b", "generation-b")
    resources.owner = b

    val staleErrorHandled = coordinator.runIfCurrent(a) { resources.release(a) }

    assertFalse(staleErrorHandled)
    assertEquals(b, resources.owner)
    assertEquals(0, resources.releaseCount)
  }

  @Test
  fun cleanupOnlyReleasesTheLeaseThatOwnsTheResources() {
    val coordinator = RingerOwnershipCoordinator()
    val a = coordinator.claim("alarm-a", "event-a", "generation-a")
    val resources = FakeResources(a)
    val b = coordinator.claim("alarm-b", "event-b", "generation-b")
    resources.owner = b

    resources.release(a)
    resources.release(b)

    assertEquals(b, resources.lastReleased)
    assertEquals(1, resources.releaseCount)
    assertEquals(null, resources.owner)
  }

  @Test
  fun duplicateClaimIsIdempotentButNewGenerationGetsNewToken() {
    val coordinator = RingerOwnershipCoordinator()
    val first = coordinator.claim("alarm-a", "event-a", "generation-a")
    val duplicate = coordinator.claim("alarm-a", "event-a", "generation-a")
    val replacement = coordinator.claim("alarm-a", "event-a", "generation-b")

    assertEquals(first, duplicate)
    assertNotEquals(first.token, replacement.token)
    assertFalse(coordinator.isCurrent(first))
    assertTrue(coordinator.isCurrent(replacement))
  }

  @Test
  fun staleActionIsRejectedForDifferentOccurrenceWithSameAlarmId() {
    val coordinator = RingerOwnershipCoordinator()
    val a = coordinator.claim("recurring-alarm", "event-today", "generation-today")
    var effects = 0
    coordinator.release(a)
    val b = coordinator.claim("recurring-alarm", "event-next", "generation-next")

    assertFalse(coordinator.runIfCurrent(a) { effects++ })
    assertEquals(0, effects)
    assertTrue(coordinator.isCurrent(b))
  }

  @Test
  fun staleAndDuplicateReleaseCannotClearNewOwner() {
    val coordinator = RingerOwnershipCoordinator()
    val a = coordinator.claim("alarm-a", "event-a", "generation-a")
    val b = coordinator.claim("alarm-b", "event-b", "generation-b")

    assertFalse(coordinator.release(a))
    assertTrue(coordinator.release(b))
    assertFalse(coordinator.release(b))
    assertEquals(null, coordinator.current())
  }

  @Test
  fun ownershipChangeWaitsForAnExecutingCallbackEffect() {
    val coordinator = RingerOwnershipCoordinator()
    val a = coordinator.claim("alarm-a", "event-a", "generation-a")
    val enteredEffect = CountDownLatch(1)
    val allowEffectToFinish = CountDownLatch(1)
    val claimStarted = CountDownLatch(1)
    val bClaimed = CountDownLatch(1)
    val effectObservedA = AtomicBoolean(false)
    lateinit var b: RingerOwnership

    val callbackThread = Thread {
      coordinator.runIfCurrent(a) {
        enteredEffect.countDown()
        allowEffectToFinish.await(5, TimeUnit.SECONDS)
        effectObservedA.set(coordinator.isCurrent(a))
      }
    }
    val replacementThread = Thread {
      claimStarted.countDown()
      b = coordinator.claim("alarm-b", "event-b", "generation-b")
      bClaimed.countDown()
    }

    callbackThread.start()
    assertTrue(enteredEffect.await(5, TimeUnit.SECONDS))
    replacementThread.start()
    assertTrue(claimStarted.await(5, TimeUnit.SECONDS))
    assertFalse(bClaimed.await(100, TimeUnit.MILLISECONDS))
    allowEffectToFinish.countDown()
    callbackThread.join(5_000)
    replacementThread.join(5_000)

    assertTrue(effectObservedA.get())
    assertTrue(bClaimed.count == 0L)
    assertTrue(coordinator.isCurrent(b))
  }

  private class FakeResources(owner: RingerOwnership?) {
    var owner: RingerOwnership? = owner
    var releaseCount = 0
    var lastReleased: RingerOwnership? = null

    fun release(expected: RingerOwnership) {
      if (owner != expected) return
      owner = null
      releaseCount += 1
      lastReleased = expected
    }
  }
}
