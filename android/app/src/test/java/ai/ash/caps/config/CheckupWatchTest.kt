package ai.ash.caps.config

import ai.ash.ui.Checkup
import ai.ash.ui.OnboardingPlan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CheckupWatchTest {
    private fun item(id: String, part: String, state: Checkup.State) = Checkup.Item(id, Checkup.part(part)!!, id, "why", state)

    @Test fun theSummaryHasEveryPartInTheChecksOrderWithItsOwnShortPhrase() {
        val body = CheckupWatch.body(listOf(item("kernel_link", "brain", Checkup.State.OFF), item("notifications", "notify", Checkup.State.ON), item("location", "location", Checkup.State.OFF)))
        val groups = body.getJSONArray("groups")
        assertEquals(OnboardingPlan.PARTS.map { it.id }, (0 until groups.length()).map { groups.getJSONObject(it).getString("id") })
        val brain = groups.getJSONObject(0)
        assertEquals(1, brain.getInt("todo")); assertEquals("可能掉线", brain.getString("text")); assertFalse(brain.getBoolean("optional"))
        assertEquals("会响会振", groups.getJSONObject(2).getString("text"))
        // the optional part is told but does not count in the number the phone shows
        val location = groups.getJSONObject(groups.length() - 1)
        assertTrue(location.getBoolean("optional")); assertEquals("没开 · 可选", location.getString("text"))
        assertEquals(1, body.getInt("todo"))
        assertTrue(groups.length() <= 16)
    }

    @Test fun nothingButCountsAndShortPhrasesIsSent() {
        val body = CheckupWatch.body(listOf(item("accessibility", "eyes", Checkup.State.OFF)))
        val groups = body.getJSONArray("groups")
        for (i in 0 until groups.length()) {
            val g = groups.getJSONObject(i)
            assertEquals(setOf("id", "title", "todo", "optional", "text"), g.keys().asSequence().toSet())
            assertTrue(g.getString("text").length <= 40); assertTrue(g.getString("title").length in 1..40)
        }
    }

    @Test fun onlyACountChangingMakesTheSummaryNew() {
        val a = CheckupWatch.signature(CheckupWatch.body(listOf(item("notifications", "notify", Checkup.State.OFF))))
        assertEquals(a, CheckupWatch.signature(CheckupWatch.body(listOf(item("notifications", "notify", Checkup.State.OFF)))))
        assertNotEquals(a, CheckupWatch.signature(CheckupWatch.body(listOf(item("notifications", "notify", Checkup.State.ON)))))
        assertNotEquals(a, CheckupWatch.signature(CheckupWatch.body(listOf(item("notifications", "notify", Checkup.State.OFF), item("alerts", "notify", Checkup.State.OFF)))))
    }
}
