package ai.ash.ui

import ai.ash.ui.Checkup.Part
import ai.ash.ui.Checkup.State
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CheckupTest {
    private fun item(part: Part, on: Boolean) = Checkup.Item("x", part, "t", "w", if (on) State.ON else State.OFF)

    @Test fun sevenPartsInTheOrderOfTheDesignAndTheIdsTheWebUses() {
        assertEquals(listOf("brain", "alarm", "notify", "awake", "eyes", "files", "location"), Part.entries.map { it.id })
        assertEquals(listOf("大脑", "闹钟", "叫你", "在后台醒着", "眼睛和手", "照片和文件", "位置和健康（可选）"), Part.entries.map { it.title })
        assertEquals(listOf(Part.LOCATION), Part.entries.filter { it.optional })
        assertEquals(Part.NOTIFY, Part.of("notify")); assertNull(Part.of("sleep")); assertNull(Part.of(null)); assertNull(Part.of(""))
    }

    @Test fun aPartWithOneItemOffNeedsFixingAndTheOptionalOneIsNotCounted() {
        val s = Checkup.summarize(listOf(item(Part.AWAKE, true), item(Part.AWAKE, false), item(Part.AWAKE, false), item(Part.EYES, false),
            item(Part.BRAIN, true), item(Part.LOCATION, false), item(Part.LOCATION, false)))
        assertEquals(2, s.todo(Part.AWAKE)); assertEquals(1, s.todo(Part.EYES)); assertEquals(0, s.todo(Part.BRAIN)); assertEquals(2, s.todo(Part.LOCATION))
        assertEquals("the number the home page shows leaves the optional part out", 3, s.todo)
    }

    @Test fun whatTheWebPageIsToldIsTheTotalAndOneCountPerPart() {
        val json = Checkup.summarize(listOf(item(Part.AWAKE, false), item(Part.LOCATION, false))).toJson()
        assertEquals("checkup", json.getString("type"))
        assertEquals(1, json.getInt("todo"))
        val groups = json.getJSONArray("groups")
        assertEquals(7, groups.length())
        assertEquals(Part.entries.map { it.id }, (0 until 7).map { groups.getJSONObject(it).getString("id") })
        assertEquals(listOf(0, 0, 0, 1, 0, 0, 1), (0 until 7).map { groups.getJSONObject(it).getInt("todo") })
    }

    @Test fun aCellSaysFixAfterTroubleAndOnlyThat() {
        for (p in Part.entries) {
            val ok = Checkup.cellText(p, 0)
            assertFalse(p.id, ok.contains("去修"))
            val bad = Checkup.cellText(p, 2)
            if (p.optional) assertEquals("没开 · 可选", bad) else assertTrue("$p: $bad", bad.endsWith(" · 去修"))
            assertFalse("$p: no code or english in what the owner reads", Regex("[A-Za-z]{3,}").containsMatchIn(ok + bad))
        }
        assertEquals("可能被清理 · 去修", Checkup.cellText(Part.AWAKE, 1))
        assertEquals("没在工作 · 去修", Checkup.cellText(Part.EYES, 3))
    }
}
