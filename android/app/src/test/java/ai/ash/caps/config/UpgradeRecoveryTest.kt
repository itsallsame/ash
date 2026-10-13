package ai.ash.caps.config

import ai.ash.caps.config.UpgradeRecovery.Action
import ai.ash.caps.config.UpgradeRecovery.Outcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UpgradeRecoveryTest {
    @Test fun planFollowsTheOwnersPriorState() {
        assertEquals(Action.NOTHING, UpgradeRecovery.plan(wanted = false, running = false))
        assertEquals(Action.NOTHING, UpgradeRecovery.plan(wanted = true, running = true))
        assertEquals(Action.ASK_OWNER, UpgradeRecovery.plan(wanted = true, running = false))
    }

    private class Fake(val wanted: Boolean, var running: Boolean = false, val restoredAfter: Long? = null) : UpgradeRecovery.Env {
        var asked = 0; var slept = 0L
        override fun wanted() = wanted
        override fun running() = running
        override fun askOwner() { asked++ }
        override fun sleep(ms: Long) { slept += ms; if (restoredAfter != null && slept >= restoredAfter) running = true }
    }

    @Test fun theOwnerIsAskedAndAshChangesNothing() {
        val env = Fake(wanted = true)
        assertEquals(Outcome.ASKED, UpgradeRecovery.run(env))
        assertEquals(1, env.asked)
    }

    @Test fun aServiceTheOwnerDidNotHaveOnIsLeftOff() {
        val env = Fake(wanted = false)
        assertEquals(Outcome.LEFT_ALONE, UpgradeRecovery.run(env))
        assertEquals(0, env.asked); assertEquals(0L, env.slept)
    }

    @Test fun ifTheSystemBringsItBackWithinTheWaitNothingIsDone() {
        val env = Fake(wanted = true, restoredAfter = 2_000)
        assertEquals(Outcome.LEFT_ALONE, UpgradeRecovery.run(env))
        assertEquals(0, env.asked)
        assertTrue(env.slept < 6_000)
    }
}
