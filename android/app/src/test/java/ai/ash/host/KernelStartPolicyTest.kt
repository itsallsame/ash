package ai.ash.host

import ai.ash.host.KernelStartPolicy.Route
import org.junit.Assert.assertEquals
import org.junit.Test

class KernelStartPolicyTest {
    private val policy = KernelStartPolicy(settleMs = 10_000, gapMs = 15_000)

    private fun route(now: Long, installed: Boolean = true, bound: Boolean = false, serviceStarted: Boolean = true, foreground: Boolean = true) =
        policy.route(now, installed, bound, serviceStarted, foreground)

    @Test fun aBoundKernelNeedsNoActivity() {
        assertEquals(Route.NONE, route(0, bound = true))
        assertEquals(Route.NONE, route(60_000, bound = true, serviceStarted = false))
    }

    @Test fun aKernelThatIsNotInstalledIsLeftAlone() {
        assertEquals(Route.NONE, route(0, installed = false, serviceStarted = false))
    }

    @Test fun aRefusedServiceStartInFrontGoesThroughTheActivity() {
        assertEquals(Route.ACTIVITY, route(0, serviceStarted = false))
    }

    @Test fun aRefusedServiceStartInTheBackgroundOnlyWaitsForTheOwner() {
        assertEquals(Route.BACKGROUND, route(0, serviceStarted = false, foreground = false))
    }

    @Test fun anAcceptedServiceStartGetsTimeBeforeItIsDoubted() {
        assertEquals(Route.SERVICE, route(0))
        assertEquals(Route.SERVICE, route(9_999))
    }

    @Test fun anAcceptedStartThatLeavesTheLinkDownGoesThroughTheActivityInFront() {
        assertEquals(Route.SERVICE, route(0))
        assertEquals(Route.ACTIVITY, route(10_000))
    }

    @Test fun anAcceptedStartThatLeavesTheLinkDownInTheBackgroundDoesNotTryTheActivity() {
        assertEquals(Route.SERVICE, route(0, foreground = false))
        assertEquals(Route.BACKGROUND, route(10_000, foreground = false))
    }

    @Test fun theActivityIsNotStartedAgainWithinTheGap() {
        assertEquals(Route.ACTIVITY, route(0, serviceStarted = false))
        assertEquals(Route.SERVICE, route(5_000, serviceStarted = false))
        assertEquals(Route.SERVICE, route(14_999, serviceStarted = false))
        assertEquals(Route.ACTIVITY, route(15_000, serviceStarted = false))
    }

    @Test fun theLinkComingUpClearsTheWait() {
        assertEquals(Route.SERVICE, route(0))
        assertEquals(Route.NONE, route(5_000, bound = true))
        // Later the kernel is gone again: a first try, not an old wait.
        assertEquals(Route.SERVICE, route(100_000))
        assertEquals(Route.SERVICE, route(105_000))
    }

    @Test fun anOldWaitIsForgottenSoTheServiceGoesFirst() {
        assertEquals(Route.SERVICE, route(0))
        assertEquals(Route.SERVICE, route(200_000))
    }
}
