package ai.ash.caps.config

import ai.ash.caps.config.KeepAliveRecheck.Install
import ai.ash.caps.config.KeepAliveRecheck.Offer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KeepAliveRecheckTest {
    private val old = Install(40, 1_000)

    @Test fun nothingHappensOnTheFirstStartOrWhenTheInstallIsTheSame() {
        for (previous in listOf(null, old)) {
            val plan = KeepAliveRecheck.plan(previous, old, batteryExempt = false, makerSwitches = true)
            assertFalse(plan.forgetWords); assertEquals(Offer.NONE, plan.offer)
        }
    }

    @Test fun anUpgradeOrReinstallAsksTheOwnerToLookOnceAndNoLongerTrustsTheirWord() {
        // A new version, or the same version installed again (only the update time moves).
        for (now in listOf(Install(41, 2_000), Install(40, 2_000))) {
            val plan = KeepAliveRecheck.plan(old, now, batteryExempt = true, makerSwitches = true)
            assertTrue(plan.forgetWords); assertEquals(Offer.SWITCHES, plan.offer)
        }
    }

    @Test fun aBatteryExemptionThatWasResetIsAskedForFirst() {
        assertEquals(Offer.BATTERY, KeepAliveRecheck.plan(old, Install(41, 2_000), batteryExempt = false, makerSwitches = true).offer)
        assertEquals(Offer.BATTERY, KeepAliveRecheck.plan(old, Install(41, 2_000), batteryExempt = false, makerSwitches = false).offer)
    }

    @Test fun onStockAndroidNothingPopsUp() {
        val stock = KeepAliveRecheck.plan(old, Install(41, 2_000), batteryExempt = true, makerSwitches = false)
        assertFalse(stock.forgetWords); assertEquals(Offer.NONE, stock.offer)
    }

    @Test fun anUpgradeFromBeforeTheRecordWasKeptCounts() {
        assertEquals(Offer.SWITCHES, KeepAliveRecheck.plan(Install(-1, -1), Install(41, 2_000), batteryExempt = true, makerSwitches = true).offer)
    }

    @Test fun onlyTheMakersSwitchesLoseTheOwnersWord() {
        val keys = Permissions.all.filter { it.key in KeepAliveRecheck.WORD_KEYS }.map { it.key }
        assertEquals(KeepAliveRecheck.WORD_KEYS.toSet(), keys.toSet())
    }
}
