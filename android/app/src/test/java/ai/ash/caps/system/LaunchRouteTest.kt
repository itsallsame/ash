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

/** How a start of a screen is routed: in front, exempt, Shizuku, ask for Shizuku, or a plain failure that says what to turn on. */
class LaunchRouteTest {
    private fun choose(
        sdk: Int = 31, foreground: Boolean = false, accessibility: Boolean = false, overlay: Boolean = false,
        shizuku: ShizukuStatus = ShizukuStatus.NOT_RUNNING,
    ) = LaunchRoute.choose(sdk, foreground, accessibility, overlay) { shizuku }

    @Test fun inFrontItStartsDirectlyWhateverElseHolds() {
        assertEquals(Way.FOREGROUND, choose(foreground = true))
        assertEquals(Way.FOREGROUND, choose(foreground = true, accessibility = true, shizuku = ShizukuStatus.READY))
    }

    @Test fun inTheBackgroundAnExemptionStartsDirectlyAsBefore() {
        assertEquals(Way.EXEMPT, choose(accessibility = true))
        assertEquals(Way.EXEMPT, choose(overlay = true))
        assertEquals(Way.EXEMPT, choose(accessibility = true, shizuku = ShizukuStatus.READY))
    }

    @Test fun theOverlayExemptionEndsWithAndroid15ButAccessibilityStays() {
        assertEquals(Way.EXEMPT, choose(sdk = 34, overlay = true))
        assertEquals(Way.BLOCKED, choose(sdk = 35, overlay = true))
        assertEquals(Way.SHIZUKU, choose(sdk = 35, overlay = true, shizuku = ShizukuStatus.READY))
        assertEquals(Way.EXEMPT, choose(sdk = 35, accessibility = true))
    }

    @Test fun withoutAnExemptionAReadyShizukuStartsIt() {
        assertEquals(Way.SHIZUKU, choose(shizuku = ShizukuStatus.READY))
    }

    @Test fun shizukuRunningButNotAuthorizedAsksTheOwner() {
        assertEquals(Way.ASK_SHIZUKU, choose(shizuku = ShizukuStatus.NEEDS_AUTH))
    }

    @Test fun otherwiseItIsBlockedAndNeverCalledASuccess() {
        for (s in listOf(ShizukuStatus.NOT_RUNNING, ShizukuStatus.NOT_INSTALLED, ShizukuStatus.TOO_OLD)) assertEquals(Way.BLOCKED, choose(shizuku = s))
    }

    @Test fun beforeAndroid10NothingRestrictsIt() {
        assertEquals(Way.FOREGROUND, choose(sdk = 28))
    }

    @Test fun shizukuIsNotLookedAtWhenAStartCanGoDirectly() {
        var asked = 0
        fun probe(): ShizukuStatus { asked++; return ShizukuStatus.READY }
        LaunchRoute.choose(31, true, false, false, ::probe)
        LaunchRoute.choose(31, false, true, false, ::probe)
        LaunchRoute.choose(28, false, false, false, ::probe)
        assertEquals(0, asked)
        LaunchRoute.choose(31, false, false, false, ::probe)
        assertEquals(1, asked)
    }

    @Test fun canStartDirectlyIgnoresShizuku() {
        assertTrue(LaunchRoute.direct(31, true, false, false))
        assertTrue(LaunchRoute.direct(31, false, true, false))
        assertFalse(LaunchRoute.direct(31, false, false, false))
        assertTrue(LaunchRoute.direct(29, false, false, true))
    }

    @Test fun theHintNamesWhatTheOwnerCanTurnOn() {
        val hint = LaunchRoute.hint(ShizukuStatus.NOT_INSTALLED)
        assertTrue(hint.contains("accessibility"))
        assertTrue(hint.contains("overlay"))
        assertTrue(hint.contains("install Shizuku"))
        assertTrue(LaunchRoute.hint(ShizukuStatus.NOT_RUNNING).contains("start the Shizuku service"))
        assertTrue(LaunchRoute.hint(ShizukuStatus.NEEDS_AUTH, asked = true).contains("Authorized apps"))
        assertTrue(LaunchRoute.hint(ShizukuStatus.TOO_OLD).contains("update Shizuku"))
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
        assertTrue(Launch("shizuku", "com.a", "com.a", true).opened)
        assertTrue(Launch("direct", "com.a", null, null).opened)
        assertFalse(Launch("shizuku", "com.a", "com.miui.home", false).opened)
        assertTrue(Launch("shizuku", "com.a", "com.miui.home", false).summary().contains("com.miui.home"))
    }

    @Test fun aBlockedStartCarriesItsHintOverTheLink() {
        val e = LaunchFailure("unavailable", "cannot open the screen", LaunchRoute.hint(ShizukuStatus.NOT_RUNNING))
        val out = DeviceCalls.outcomeOf(CapResult.error(e.code, e.message!!, e.hint)) as CallOutcome.Err
        assertEquals("unavailable", out.code)
        assertEquals(e.hint, out.recoveryHint)
        assertNull((DeviceCalls.outcomeOf(CapResult.error("failed", "x")) as CallOutcome.Err).recoveryHint)
    }
}
