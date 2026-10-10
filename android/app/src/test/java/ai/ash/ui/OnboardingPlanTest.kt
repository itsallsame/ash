package ai.ash.ui

import ai.ash.caps.config.ConfigStatus
import ai.ash.host.KernelState
import ai.ash.ui.OnboardingPlan.Row
import ai.ash.ui.OnboardingStep.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OnboardingPlanTest {
    private val bound = KernelState.BOUND

    /** Every item the guide lists, all granted unless [missing] names it. */
    private fun rows(vararg missing: String, unsupported: Set<String> = emptySet()): List<Row> =
        (ConfigStatus.NAMES + listOf("autostart", "recents_lock", "screen_recovery")).map {
            Row(it, when (it) { in unsupported -> "unsupported"; in missing -> "missing"; else -> "granted" })
        }

    private fun step(kernel: KernelState = bound, rows: List<Row> = rows(), skipped: Set<OnboardingStep> = emptySet()) =
        OnboardingPlan.current(kernel, rows, skipped)

    @Test fun theKernelComesFirst() {
        assertEquals(KERNEL, step(KernelState.NOT_INSTALLED, rows("notifications")))
        assertEquals(KERNEL, step(KernelState.NOT_RUNNING, rows("accessibility")))
    }

    @Test fun onceBoundTheFirstStepWithSomethingMissingIsNext() {
        assertEquals(PERMISSIONS, step(rows = rows("exact_alarm", "accessibility", "location")))
        assertEquals(SCREEN_ACCESS, step(rows = rows("notification_listener", "health")))
        assertEquals(SENSES, step(rows = rows("location_background")))
        assertEquals(DONE, step())
    }

    @Test fun keepAliveSwitchesAreStepTwoAndRecoveryGrantIsStepThree() {
        assertEquals(PERMISSIONS, step(rows = rows("autostart")))
        assertEquals(PERMISSIONS, step(rows = rows("recents_lock")))
        assertEquals(SCREEN_ACCESS, step(rows = rows("screen_recovery")))
    }

    @Test fun whatThePhoneCannotHaveDoesNotHoldTheGuide() {
        assertEquals(PERMISSIONS, step(rows = rows("shizuku", "health", "overlay", unsupported = setOf("shizuku", "health"))))
        assertEquals(DONE, step(rows = rows("shizuku", "health", unsupported = setOf("shizuku", "health"))))
    }

    @Test fun aSkippedStepIsNotShownAgain() {
        val r = rows("exact_alarm", "accessibility", "health")
        assertEquals(PERMISSIONS, step(rows = r))
        assertEquals(SCREEN_ACCESS, step(rows = r, skipped = setOf(PERMISSIONS)))
        assertEquals(SENSES, step(rows = r, skipped = setOf(PERMISSIONS, SCREEN_ACCESS)))
        assertEquals(DONE, step(rows = r, skipped = setOf(PERMISSIONS, SCREEN_ACCESS, SENSES)))
    }

    @Test fun aStepEndsWhenTheOwnerGrantsItsLastItem() {
        assertEquals(SCREEN_ACCESS, step(rows = rows("accessibility", "notification_listener")))
        assertEquals(SCREEN_ACCESS, step(rows = rows("notification_listener")))
        assertEquals(DONE, step(rows = rows()))
    }

    @Test fun skippingTheKernelGoesOnToThePermissionsWithoutTheKernelsOwnBatteryItem() {
        val r = rows("kernel_battery_optimization")
        assertEquals(DONE, step(KernelState.NOT_INSTALLED, r, setOf(KERNEL)))
        assertEquals(PERMISSIONS, step(KernelState.NOT_RUNNING, r, setOf(KERNEL)))
    }

    @Test fun everyConfigStatusItemHasAStepAndTheKernelAndDoneOwnNone() {
        for (name in ConfigStatus.NAMES) assertTrue(name, OnboardingPlan.stepOf(name) in setOf(PERMISSIONS, SCREEN_ACCESS, SENSES))
        assertFalse(OnboardingPlan.complete(DONE, bound, rows()))
        assertTrue(OnboardingPlan.complete(KERNEL, bound, rows("accessibility")))
        assertFalse(OnboardingPlan.complete(KERNEL, KernelState.NOT_RUNNING, rows()))
    }

    @Test fun theSensesAndSpecialAccessesAreWhereTheSpecPutsThem() {
        assertEquals(setOf("location", "location_background", "activity_recognition", "health"), ConfigStatus.NAMES.filter { OnboardingPlan.stepOf(it) == SENSES }.toSet())
        assertEquals(setOf("accessibility", "notification_listener"), ConfigStatus.NAMES.filter { OnboardingPlan.stepOf(it) == SCREEN_ACCESS }.toSet())
    }
}
