package ai.ash.caps.config

import ai.ash.caps.config.UpgradeRecovery.Action
import ai.ash.caps.config.UpgradeRecovery.Outcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UpgradeRecoveryTest {
    @Test fun planFollowsTheOwnersPriorStateAndTheGrant() {
        assertEquals(Action.NOTHING, UpgradeRecovery.plan(wanted = false, running = false, secureGranted = true))
        assertEquals(Action.NOTHING, UpgradeRecovery.plan(wanted = true, running = true, secureGranted = false))
        assertEquals(Action.ENABLE, UpgradeRecovery.plan(wanted = true, running = false, secureGranted = true))
        assertEquals(Action.ASK_OWNER, UpgradeRecovery.plan(wanted = true, running = false, secureGranted = false))
    }

    private class Fake(
        val wanted: Boolean, val secure: Boolean, var running: Boolean = false,
        val enableWorks: Boolean = true, val restoredAfter: Long? = null,
    ) : UpgradeRecovery.Env {
        var enabled = 0; var asked = 0; var slept = 0L
        override fun wanted() = wanted
        override fun running() = running
        override fun secureGranted() = secure
        override fun enable(): Boolean { enabled++; running = enableWorks; return enableWorks }
        override fun askOwner() { asked++ }
        override fun sleep(ms: Long) { slept += ms; if (restoredAfter != null && slept >= restoredAfter) running = true }
    }

    @Test fun withTheGrantTheServiceIsTurnedBackOn() {
        val env = Fake(wanted = true, secure = true)
        assertEquals(Outcome.ENABLED, UpgradeRecovery.run(env))
        assertEquals(1, env.enabled); assertEquals(0, env.asked)
    }

    @Test fun withoutTheGrantTheOwnerIsAskedAndNothingIsChanged() {
        val env = Fake(wanted = true, secure = false)
        assertEquals(Outcome.ASKED, UpgradeRecovery.run(env))
        assertEquals(0, env.enabled); assertEquals(1, env.asked)
    }

    @Test fun ifTurningItOnDoesNotWorkTheOwnerIsAskedToo() {
        val env = Fake(wanted = true, secure = true, enableWorks = false)
        assertEquals(Outcome.ASKED, UpgradeRecovery.run(env))
        assertEquals(1, env.enabled); assertEquals(1, env.asked)
    }

    @Test fun aServiceTheOwnerDidNotHaveOnIsLeftOff() {
        val env = Fake(wanted = false, secure = true)
        assertEquals(Outcome.LEFT_ALONE, UpgradeRecovery.run(env))
        assertEquals(0, env.enabled); assertEquals(0, env.asked); assertEquals(0L, env.slept)
    }

    @Test fun ifTheSystemBringsItBackWithinTheWaitNothingIsDone() {
        val env = Fake(wanted = true, secure = true, restoredAfter = 2_000)
        assertEquals(Outcome.LEFT_ALONE, UpgradeRecovery.run(env))
        assertEquals(0, env.enabled); assertEquals(0, env.asked)
        assertTrue(env.slept < 6_000)
    }
}
