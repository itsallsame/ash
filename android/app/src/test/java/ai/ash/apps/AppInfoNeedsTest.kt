package ai.ash.apps

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppInfoNeedsTest {
    private fun list(json: String) = AppInfo.list(JSONArray(json))

    @Test fun anAppsNeedsErrorAndRunningStateAreRead() {
        val a = list("""[{"id":"health","name":"健康","version":"1.2","enabled":true,"granted":true,"running":true,
            "needs":[{"member":"service:health","words":["steps"],"why":"读你的步数"},{"notify":true},{"widgets":true,"why":"  "},{"card":true,"why":"放个入口"},{"nothing":1},"x"],
            "error":"  它停了  "}]""").single()
        assertEquals(listOf("member" to "读你的步数", "notify" to "到点提醒你", "widgets" to "在桌面放一个小组件", "card" to "放个入口"), a.needs.map { it.kind to it.text })
        assertTrue(a.running)
        assertEquals("它停了", a.error)
        assertTrue(a.usable)
    }

    @Test fun anAppWithoutThemHasNone() {
        val a = list("""[{"id":"notes","enabled":false,"granted":true}]""").single()
        assertTrue(a.needs.isEmpty()); assertFalse(a.running); assertEquals("", a.error); assertFalse(a.usable)
    }

    @Test fun aNeedWithoutALineOfItsOwnSaysWhatItIsInPlainWords() {
        assertEquals("使用 Ash 的能力", AppInfo.Need("member", "").text)
        assertEquals("读你的步数", AppInfo.Need("member", "读你的步数").text)
    }
}
