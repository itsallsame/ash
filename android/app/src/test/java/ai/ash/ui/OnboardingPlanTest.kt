package ai.ash.ui

import ai.ash.caps.config.ConfigStatus
import ai.ash.caps.config.KernelAutostart
import ai.ash.host.KernelState
import ai.ash.ui.OnboardingPlan.Row
import ai.ash.ui.OnboardingStep.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    @Test fun keepAliveSwitchesAreStepTwoAndRecoveryGrantIsShownInStepThreeButDoesNotHoldIt() {
        assertEquals(PERMISSIONS, step(rows = rows("autostart")))
        assertEquals(PERMISSIONS, step(rows = rows("recents_lock")))
        assertEquals(DONE, step(rows = rows("screen_recovery")))
        assertEquals(SCREEN_ACCESS, step(rows = rows("screen_recovery", "accessibility")))
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

    @Test fun miuiAndColorosGetTheLineAboutTheSystemQuestion() {
        for (maker in listOf("Xiaomi", "Redmi", "POCO", "OPPO", "OnePlus", "realme")) {
            val line = OnboardingPlan.kernelPrompt(KernelAutostart.rom(maker))
            assertEquals("装好后系统会问你一次，请选「始终允许」。", line)
        }
    }

    @Test fun otherPhonesGetNoLineAndNoRefusedRetry() {
        val rom = KernelAutostart.rom("samsung")
        assertNull(OnboardingPlan.kernelPrompt(rom))
        assertNull(OnboardingPlan.kernelRetryHint(rom))
        assertFalse(OnboardingPlan.showRefusedRetry(rom, 10 * OnboardingPlan.KERNEL_WAIT_MS))
    }

    @Test fun theRefusedRetryShowsOnlyAfterThirtySeconds() {
        val rom = KernelAutostart.rom("Xiaomi")
        assertEquals(30_000L, OnboardingPlan.KERNEL_WAIT_MS)
        assertFalse(OnboardingPlan.showRefusedRetry(rom, 0))
        assertFalse(OnboardingPlan.showRefusedRetry(rom, 29_999))
        assertTrue(OnboardingPlan.showRefusedRetry(rom, 30_000))
        assertTrue(OnboardingPlan.showRefusedRetry(KernelAutostart.rom("oppo"), 120_000))
        assertEquals("如果刚才选了拒绝，点这里重试", OnboardingPlan.kernelRetryHint(rom))
    }

    // ---- one thing per screen ----

    private fun page(kernel: KernelState = bound, rows: List<Row> = rows(), kernelSkipped: Boolean = false, skipped: Set<String> = emptySet()) =
        OnboardingPlan.page(kernel, rows, kernelSkipped, skipped)

    @Test fun theBrainComesBeforeAnyItemUnlessThePhoneSkippedIt() {
        assertEquals(OnboardingPlan.Page(OnboardingPlan.Kind.BRAIN), page(KernelState.NOT_INSTALLED, rows("notifications")))
        assertEquals(OnboardingPlan.Page(OnboardingPlan.Kind.BRAIN), page(KernelState.NOT_RUNNING, rows("accessibility")))
        assertEquals(OnboardingPlan.Page(OnboardingPlan.Kind.ITEM, "notifications"), page(KernelState.NOT_INSTALLED, rows("notifications"), kernelSkipped = true))
        assertEquals(OnboardingPlan.Page(OnboardingPlan.Kind.DONE), page())
    }

    @Test fun theFirstItemLeftIsAskedAndAnAnsweredOneIsNot() {
        val r = rows("health", "notifications", "overlay")
        assertEquals("notifications", page(rows = r).item)
        assertEquals("overlay", page(rows = r, skipped = setOf("notifications")).item)
        assertEquals("health", page(rows = r, skipped = setOf("notifications", "overlay")).item)
        assertEquals(OnboardingPlan.Kind.DONE, page(rows = r, skipped = setOf("notifications", "overlay", "health")).kind)
    }

    @Test fun whatMattersIsAskedFirstAndTheSensesLast() {
        val order = OnboardingPlan.asked(bound, rows("health", "location", "accessibility", "notifications", "battery_optimization", "photos"))
        assertEquals(listOf("notifications", "battery_optimization", "accessibility", "photos", "location", "health"),
            order.filter { it in setOf("health", "location", "accessibility", "notifications", "battery_optimization", "photos") })
        assertTrue(order.indexOf("accessibility") < order.indexOf("location"))
    }

    @Test fun everyItemTheGuideCanReadHasAPlaceInTheOrderAndACopy() {
        val items = ConfigStatus.NAMES + listOf("autostart", "kernel_autostart", "recents_lock", "screen_recovery")
        for (item in items) {
            assertTrue("$item is not in the order", item in OnboardingPlan.ASK_ORDER)
            assertTrue("$item has no copy", item in OnboardingContent.pages)
        }
        assertEquals(OnboardingPlan.ASK_ORDER.size, OnboardingPlan.ASK_ORDER.toSet().size)
        assertEquals(items.toSet(), OnboardingPlan.ASK_ORDER.toSet())
    }

    @Test fun anUnknownItemIsAskedAtTheEndAndNeverLost() {
        val r = rows() + Row("future_thing", "missing")
        assertEquals("future_thing", OnboardingPlan.asked(bound, r).last())
        assertEquals("future_thing", page(rows = r).item)
    }

    @Test fun whatThePhoneCannotHaveIsNeverAsked() {
        val r = rows("health", "shizuku", "overlay", unsupported = setOf("health", "shizuku"))
        assertEquals(listOf("overlay"), OnboardingPlan.pending(bound, r, emptySet()))
        assertFalse("health" in OnboardingPlan.asked(bound, r))
    }

    @Test fun theKernelsOwnSwitchesWaitForTheKernel() {
        val r = rows("kernel_battery_optimization") + Row("kernel_autostart", "missing")
        assertEquals(emptyList<String>(), OnboardingPlan.pending(KernelState.NOT_INSTALLED, r, emptySet()))
        assertEquals(listOf("kernel_battery_optimization", "kernel_autostart"), OnboardingPlan.pending(KernelState.NOT_RUNNING, r, emptySet()))
    }

    @Test fun theRecoveryGrantIsAskedOnlyWhileAccessIsOpenAndNotAfterAccessibilityWasPassedOn() {
        // as in the old step: it never holds the guide, and is shown only next to the accesses that are still open
        assertEquals(emptyList<String>(), OnboardingPlan.pending(bound, rows("screen_recovery"), emptySet()))
        assertEquals(listOf("screen_recovery", "notification_listener").sorted(), OnboardingPlan.pending(bound, rows("screen_recovery", "notification_listener"), emptySet()).sorted())
        assertEquals(listOf("accessibility", "screen_recovery").sorted(), OnboardingPlan.pending(bound, rows("screen_recovery", "accessibility"), emptySet()).sorted())
        assertEquals(listOf("accessibility"), OnboardingPlan.pending(bound, rows("screen_recovery", "accessibility"), setOf("screen_recovery")))
        // passing on accessibility passes on its recovery too, even if the recovery was not marked
        assertEquals(listOf("notification_listener"), OnboardingPlan.pending(bound, rows("screen_recovery", "accessibility", "notification_listener"), setOf("accessibility")))
    }

    @Test fun theDotsAreTheItemsShownOrStillToCome() {
        val r = rows("notifications", "accessibility", "location")
        assertEquals(listOf("notifications", "accessibility", "location"), OnboardingPlan.dots(bound, r, emptySet(), emptyList()))
        // one that was granted while the owner was on it stays a dot; one that was granted before the guide started never is
        val after = rows("accessibility", "location")
        assertEquals(listOf("notifications", "accessibility", "location"), OnboardingPlan.dots(bound, after, emptySet(), listOf("notifications")))
        assertEquals(listOf("accessibility", "location"), OnboardingPlan.dots(bound, after, emptySet(), emptyList()))
    }

    @Test fun theClosingScreenCountsWhatIsOnAndNamesWhatIsNot() {
        val none = OnboardingPlan.summary(bound, rows())
        assertEquals(OnboardingPlan.asked(bound, rows()).size + 1, none.on)
        assertEquals(emptyList<String>(), none.off)
        val some = OnboardingPlan.summary(bound, rows("overlay", "location", "health"))
        assertEquals(listOf("overlay", "location", "health"), some.off)
        assertEquals(some.on + 3, some.total)
        val noBrain = OnboardingPlan.summary(KernelState.NOT_INSTALLED, rows())
        assertEquals(OnboardingPlan.BRAIN, noBrain.off.first())
    }

    @Test fun theOwnerHearsOfTheBrainNotTheKernel() {
        assertEquals("大脑的安装包没装上", OnboardingPlan.brainWords("内核包没装上"))
        assertEquals("大脑没起来", OnboardingPlan.brainWords("内核没起来"))
    }

    // ---- the parts of her body ----

    @Test fun thePartsAreTheCheckupsSevenWithTheIdsOfTheSplitSpec() {
        assertEquals(listOf("brain", "alarm", "notify", "awake", "eyes", "files", "location"), OnboardingPlan.PARTS.map { it.id })
        assertEquals(listOf("大脑", "闹钟", "叫你", "在后台醒着", "眼睛和手", "照片和文件", "位置和健康"), OnboardingPlan.PARTS.map { it.title })
    }

    @Test fun everyItemIsInOnePartAndTheOnesTheHandoffListsAreWhereItPutsThem() {
        val items = ConfigStatus.NAMES + listOf("autostart", "kernel_autostart", "recents_lock", "screen_recovery")
        for (item in items) assertEquals(item, 1, OnboardingPlan.PARTS.count { item in it.items })
        assertEquals("brain", OnboardingPlan.partOf("kernel_battery_optimization").id)
        assertEquals("alarm", OnboardingPlan.partOf("exact_alarm").id)
        assertEquals("location", OnboardingPlan.partOf("calendar").id) // optional: reading the calendar is no part of an alarm being on time
        assertEquals("notify", OnboardingPlan.partOf("notifications").id)
        assertEquals("notify", OnboardingPlan.partOf("alerts").id) // not a row of config.status: the checkup lists it, under 叫你 (HANDOFF §3)
        assertEquals("awake", OnboardingPlan.partOf("recents_lock").id)
        assertEquals("eyes", OnboardingPlan.partOf("accessibility").id)
        assertEquals("eyes", OnboardingPlan.partOf("notification_listener").id)
        assertEquals("files", OnboardingPlan.partOf("usage_access").id)
        assertEquals("location", OnboardingPlan.partOf("health").id)
        assertEquals("location", OnboardingPlan.partOf("future_thing").id)
    }

    @Test fun theDotsAreOnePerPartInTheOrderTheGuideAsks() {
        val r = rows("location", "accessibility", "notification_listener", "notifications", "photos", "health")
        assertEquals(listOf("notify", "eyes", "files", "location"), OnboardingPlan.dotParts(bound, r, emptySet(), emptyList()))
        // a part whose items are all granted before the guide starts has no dot; one just finished keeps its dot
        assertEquals(listOf("eyes", "files", "location"), OnboardingPlan.dotParts(bound, rows("accessibility", "photos", "location"), emptySet(), emptyList()))
        assertEquals(listOf("notify", "eyes", "files", "location"), OnboardingPlan.dotParts(bound, rows("accessibility", "photos", "location"), emptySet(), listOf("notifications")))
        // the calendar is one of the optional ones: a missing calendar is a dot under 位置和健康, not under 闹钟
        assertEquals(listOf("location"), OnboardingPlan.dotParts(bound, rows("calendar"), emptySet(), emptyList()))
        assertEquals(listOf("alarm"), OnboardingPlan.dotParts(bound, rows("exact_alarm"), emptySet(), emptyList()))
        assertTrue(OnboardingPlan.dotParts(KernelState.NOT_RUNNING, rows(unsupported = emptySet()) + Row("kernel_autostart", "missing"), emptySet(), emptyList()).size <= 7)
    }

    @Test fun theClosingScreenNamesPartsNotItems() {
        val s = OnboardingPlan.summary(bound, rows("accessibility", "overlay", "location", "health"))
        assertEquals(listOf("眼睛和手", "位置和健康"), s.offParts.map { it.title })
        val all = OnboardingPlan.summary(KernelState.NOT_INSTALLED, rows(*ConfigStatus.NAMES.toTypedArray(), "autostart", "recents_lock"))
        assertTrue(all.offParts.size <= 7)
        assertEquals("brain", all.offParts.first().id)
        assertEquals(emptyList<OnboardingPlan.Part>(), OnboardingPlan.summary(bound, rows()).offParts)
    }
}
