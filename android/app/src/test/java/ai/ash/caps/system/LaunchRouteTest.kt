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

/** How a start of a screen is routed: in front, exempt, the phone's debug identity, or a plain failure that says what to turn on. */
class LaunchRouteTest {
    private fun choose(
        sdk: Int = 31, foreground: Boolean = false, accessibility: Boolean = false, overlay: Boolean = false,
        hostShell: HostShellStatus = HostShellStatus.ABSENT,
    ) = LaunchRoute.choose(sdk, foreground, accessibility, overlay, hostShell)

    @Test fun inFrontItStartsDirectlyWhateverElseHolds() {
        assertEquals(Way.FOREGROUND, choose(foreground = true))
        assertEquals(Way.FOREGROUND, choose(foreground = true, accessibility = true, hostShell = HostShellStatus.READY))
    }

    @Test fun inTheBackgroundAnExemptionStartsDirectlyAsBefore() {
        assertEquals(Way.EXEMPT, choose(accessibility = true))
        assertEquals(Way.EXEMPT, choose(overlay = true))
        assertEquals(Way.EXEMPT, choose(accessibility = true, hostShell = HostShellStatus.READY))
    }

    @Test fun theOverlayExemptionEndsWithAndroid15ButAccessibilityStays() {
        assertEquals(Way.EXEMPT, choose(sdk = 34, overlay = true))
        assertEquals(Way.BLOCKED, choose(sdk = 35, overlay = true))
        assertEquals(Way.HOST_SHELL, choose(sdk = 35, overlay = true, hostShell = HostShellStatus.READY))
        assertEquals(Way.EXEMPT, choose(sdk = 35, accessibility = true))
    }

    @Test fun withoutAnExemptionAConnectedDebugIdentityStartsIt() {
        assertEquals(Way.HOST_SHELL, choose(hostShell = HostShellStatus.READY))
    }

    @Test fun otherwiseItIsBlockedAndNeverCalledASuccess() {
        for (s in listOf(HostShellStatus.ABSENT, HostShellStatus.NOT_PAIRED)) assertEquals(Way.BLOCKED, choose(hostShell = s))
    }

    @Test fun beforeAndroid10NothingRestrictsIt() {
        assertEquals(Way.FOREGROUND, choose(sdk = 28))
    }

    @Test fun canStartDirectlyIgnoresTheDebugIdentity() {
        assertTrue(LaunchRoute.direct(31, true, false, false))
        assertTrue(LaunchRoute.direct(31, false, true, false))
        assertFalse(LaunchRoute.direct(31, false, false, false))
        assertTrue(LaunchRoute.direct(29, false, false, true))
    }

    @Test fun theHintNamesWhatTheOwnerCanTurnOn() {
        val hint = LaunchRoute.hint(HostShellStatus.NOT_PAIRED)
        assertTrue(hint.contains("accessibility"))
        assertTrue(hint.contains("overlay"))
        assertTrue(hint.contains("pair"))
        assertTrue(LaunchRoute.hint(HostShellStatus.ABSENT).contains("Wireless debugging"))
    }

    @Test fun theFrontPackageComesFromTheResumedActivityFirst() {
        val dump = """
            topResumedActivity=ActivityRecord{1a2b3c u0 com.taobao.taobao/.homepage.MainActivity3 t812}
              mResumedActivity: ActivityRecord{9f u0 com.other.app/.Old t7}
              mCurrentFocus=Window{44 u0 com.focus.app/com.focus.app.Main}
        """.trimIndent()
        assertEquals("com.taobao.taobao", LaunchRoute.parseFront(dump))
    }

    @Test fun theFocusedWindowAnswersWhenNoResumedActivityIsListed() {
        assertEquals("com.miui.home", LaunchRoute.parseFront("  mCurrentFocus=Window{12ab u0 com.miui.home/com.miui.home.launcher.Launcher}"))
        assertEquals("com.android.settings", LaunchRoute.parseFront("  mFocusedApp=ActivityRecord{7 u0 com.android.settings/.Settings t3}"))
    }

    @Test fun nothingReadableIsNull() {
        assertNull(LaunchRoute.parseFront(""))
        assertNull(LaunchRoute.parseFront("  mCurrentFocus=null"))
        assertNull(LaunchRoute.parseFront("no activity here"))
    }

    @Test fun confirmedComparesOnlyWhenBothSidesAreKnown() {
        assertEquals(true, LaunchRoute.confirmed("com.a", "com.a"))
        assertEquals(false, LaunchRoute.confirmed("com.a", "com.b"))
        assertNull(LaunchRoute.confirmed(null, "com.b"))
        assertNull(LaunchRoute.confirmed("com.a", null))
    }

    @Test fun anUnconfirmedStartIsNotReportedAsOpened() {
        assertTrue(Launch("host_shell", "com.a", "com.a", true).opened)
        assertTrue(Launch("direct", "com.a", null, null).opened)
        assertFalse(Launch("host_shell", "com.a", "com.miui.home", false).opened)
        assertTrue(Launch("host_shell", "com.a", "com.miui.home", false).summary().contains("com.miui.home"))
    }

    @Test fun aBlockedStartCarriesItsHintOverTheLink() {
        val e = LaunchFailure("unavailable", "cannot open the screen", LaunchRoute.hint(HostShellStatus.ABSENT))
        val out = DeviceCalls.outcomeOf(CapResult.error(e.code, e.message!!, e.hint)) as CallOutcome.Err
        assertEquals("unavailable", out.code)
        assertEquals(e.hint, out.recoveryHint)
        assertNull((DeviceCalls.outcomeOf(CapResult.error("failed", "x")) as CallOutcome.Err).recoveryHint)
    }
}
