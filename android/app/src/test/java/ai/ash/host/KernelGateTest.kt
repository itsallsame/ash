package ai.ash.host

import ai.ash.host.KernelGate.Action
import org.junit.Assert.assertEquals
import org.junit.Test

class KernelGateTest {
    @Test fun stateFollowsInstalledAndBound() {
        assertEquals(KernelState.NOT_INSTALLED, KernelGate.state(installed = false, bound = false))
        assertEquals(KernelState.NOT_INSTALLED, KernelGate.state(installed = false, bound = true))
        assertEquals(KernelState.NOT_RUNNING, KernelGate.state(installed = true, bound = false))
        assertEquals(KernelState.BOUND, KernelGate.state(installed = true, bound = true))
    }

    @Test fun notInstalledGuidesTheInstall() {
        assertEquals(Action.INSTALL, KernelGate.action(KernelState.NOT_INSTALLED, 0))
        assertEquals(Action.INSTALL, KernelGate.action(KernelState.NOT_INSTALLED, 9))
    }

    @Test fun notRunningIsStartedAFewTimesThenLeftToTheOwner() {
        for (tried in 0 until KernelGate.MAX_STARTS) assertEquals(Action.START, KernelGate.action(KernelState.NOT_RUNNING, tried))
        assertEquals(Action.WAIT, KernelGate.action(KernelState.NOT_RUNNING, KernelGate.MAX_STARTS))
    }

    @Test fun boundCarriesOn() {
        assertEquals(Action.PROCEED, KernelGate.action(KernelState.BOUND, 0))
        assertEquals(Action.PROCEED, KernelGate.action(KernelState.BOUND, 5))
    }
}
