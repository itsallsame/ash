package ai.ash.caps.system

import ai.ash.caps.CapResult
import ai.ash.caps.DeviceCalls
import ai.ash.caps.system.LaunchRoute.Way
import ai.ash.link.CallOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** How a start of a screen from the hand app is routed: in front, exempt, or a plain failure that says what to turn on. */
class LaunchRouteTest {
    private fun choose(sdk: Int = 31, foreground: Boolean = false, accessibility: Boolean = false, overlay: Boolean = false) =
        LaunchRoute.choose(sdk, foreground, accessibility, overlay)

    @Test fun inFrontItStartsDirectlyWhateverElseHolds() {
        assertEquals(Way.FOREGROUND, choose(foreground = true))
        assertEquals(Way.FOREGROUND, choose(foreground = true, accessibility = true))
    }

    @Test fun inTheBackgroundAnExemptionStartsDirectly() {
        assertEquals(Way.EXEMPT, choose(accessibility = true))
        assertEquals(Way.EXEMPT, choose(overlay = true))
    }

    @Test fun theOverlayExemptionEndsWithAndroid15ButAccessibilityStays() {
        assertEquals(Way.EXEMPT, choose(sdk = 34, overlay = true))
        assertEquals(Way.BLOCKED, choose(sdk = 35, overlay = true))
        assertEquals(Way.EXEMPT, choose(sdk = 35, accessibility = true))
    }

    @Test fun otherwiseItIsBlockedAndNeverCalledASuccess() {
        assertEquals(Way.BLOCKED, choose())
    }

    @Test fun beforeAndroid10NothingRestrictsIt() {
        assertEquals(Way.FOREGROUND, choose(sdk = 28))
    }

    @Test fun canStartDirectlyNeedsFrontOrAnExemption() {
        assertTrue(LaunchRoute.direct(31, true, false, false))
        assertTrue(LaunchRoute.direct(31, false, true, false))
        assertFalse(LaunchRoute.direct(31, false, false, false))
        assertTrue(LaunchRoute.direct(29, false, false, true))
    }

    @Test fun theHintNamesWhatTheOwnerCanTurnOn() {
        assertTrue(LaunchRoute.HINT.contains("accessibility"))
        assertTrue(LaunchRoute.HINT.contains("overlay"))
    }

    @Test fun confirmedComparesOnlyWhenBothSidesAreKnown() {
        assertEquals(true, LaunchRoute.confirmed("com.a", "com.a"))
        assertEquals(false, LaunchRoute.confirmed("com.a", "com.b"))
        assertNull(LaunchRoute.confirmed(null, "com.b"))
        assertNull(LaunchRoute.confirmed("com.a", null))
    }

    @Test fun anUnconfirmedStartIsNotReportedAsOpened() {
        assertTrue(Launch("direct", "com.a", "com.a", true).opened)
        assertTrue(Launch("direct", "com.a", null, null).opened)
        assertFalse(Launch("direct", "com.a", "com.miui.home", false).opened)
        assertTrue(Launch("direct", "com.a", "com.miui.home", false).summary().contains("com.miui.home"))
    }

    @Test fun aBlockedStartCarriesItsHintOverTheLink() {
        val e = LaunchFailure("unavailable", "cannot open the screen", LaunchRoute.HINT)
        val out = DeviceCalls.outcomeOf(CapResult.error(e.code, e.message!!, e.hint)) as CallOutcome.Err
        assertEquals("unavailable", out.code)
        assertEquals(e.hint, out.recoveryHint)
        assertNull((DeviceCalls.outcomeOf(CapResult.error("failed", "x")) as CallOutcome.Err).recoveryHint)
    }
}
