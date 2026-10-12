package ai.ash.ui

import ai.ash.ui.Checkup.State
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class CheckupTest {
    private fun part(id: String) = Checkup.part(id)!!
    private fun item(part: String, on: Boolean) = Checkup.Item("x", part(part), "t", "w", if (on) State.ON else State.OFF)

    @Test fun thePartsAreTheOneTableOfTheGuide() {
        assertEquals(listOf("brain", "alarm", "notify", "awake", "eyes", "files", "location"), OnboardingPlan.PARTS.map { it.id })
        assertSame(OnboardingPlan.PARTS[2], Checkup.part("notify"))
        assertNull(Checkup.part("sleep")); assertNull(Checkup.part(null)); assertNull(Checkup.part(""))
        assertEquals(listOf("location"), OnboardingPlan.PARTS.filter { Checkup.optional(it) }.map { it.id })
        assertEquals("位置和健康（可选）", Checkup.title(part("location"))); assertEquals("叫你", Checkup.title(part("notify")))
    }

    @Test fun aPartWithOneItemOffNeedsFixingAndTheOptionalOneIsNotCounted() {
        val s = Checkup.summarize(listOf(item("awake", true), item("awake", false), item("awake", false), item("eyes", false),
            item("brain", true), item("location", false), item("location", false)))
        assertEquals(2, s.todo(part("awake"))); assertEquals(1, s.todo(part("eyes"))); assertEquals(0, s.todo(part("brain"))); assertEquals(2, s.todo(part("location")))
        assertEquals("the number the home page shows leaves the optional part out", 3, s.todo)
    }

    @Test fun aCellSaysFixAfterTroubleAndOnlyThat() {
        for (p in OnboardingPlan.PARTS) {
            val ok = Checkup.cellText(p, 0)
            assertFalse(p.id, ok.contains("去修"))
            val bad = Checkup.cellText(p, 2)
            if (Checkup.optional(p)) assertEquals("没开 · 可选", bad) else assertTrue("${p.id}: $bad", bad.endsWith(" · 去修"))
            assertFalse("${p.id}: no code or english in what the owner reads", Regex("[A-Za-z]{3,}").containsMatchIn(ok + bad))
        }
        assertEquals("可能被清理 · 去修", Checkup.cellText(part("awake"), 1))
        assertEquals("没在工作 · 去修", Checkup.cellText(part("eyes"), 3))
    }

    /** HANDOFF §3's table, item by item: each item the checkup lists is in the part the table puts it in (the table itself is the guide's, [OnboardingPlan.PARTS]). */
    @Test fun everyItemIsInThePartTheHandoffPutsIt() {
        val expected = mapOf(
            "kernel_package" to "brain", "kernel_link" to "brain", "kernel_battery_optimization" to "brain", "kernel_autostart" to "brain", "kernel_lock" to "brain",
            "exact_alarm" to "alarm",
            "notifications" to "notify", "alerts" to "notify",
            "battery_optimization" to "awake", "autostart" to "awake",
            "accessibility" to "eyes", "notification_listener" to "eyes", "overlay" to "eyes", "host_shell" to "eyes",
            "photos" to "files", "all_files" to "files", "write_settings" to "files", "usage_access" to "files",
            "location" to "location", "location_background" to "location", "activity_recognition" to "location", "health" to "location", "calendar" to "location",
        )
        assertEquals(expected.keys, Checkup.ITEM_IDS.toSet())
        for ((id, part) in expected) assertEquals(id, part, Checkup.partFor(id).id)
    }

    @Test fun anItemTheOwnerSaidIsOnIsNotSomethingToDealWith() {
        fun said(part: String) = Checkup.Item("x", part(part), "t", "w", State.SAID, "你说已开")
        val s = Checkup.summarize(listOf(said("awake"), item("awake", false), said("eyes"), said("location")))
        assertEquals(1, s.todo(part("awake"))); assertEquals(0, s.todo(part("eyes"))); assertEquals(0, s.todo(part("location")))
        assertEquals(1, s.todo)
    }

    @Test fun whatTheOwnerSaidIsToldTruthfully() {
        assertEquals("你说已开", Checkup.saidNote(false))
        assertEquals("你说已开，但系统还显示没开", Checkup.saidNote(true))
    }
}
