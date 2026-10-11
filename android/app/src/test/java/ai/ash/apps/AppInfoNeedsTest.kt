package ai.ash.apps

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    @Test fun anAppWithABrokenManifestIsNotOneThatWantsInAndSaysSoInPlainWords() {
        val bad = list("""[{"id":"x","name":"x","enabled":false,"granted":false,"error":"app.json: 不是合法的 JSON：Unexpected token","problem":"manifest"}]""").single()
        assertTrue(bad.broken); assertFalse(bad.usable)
        assertEquals("这个应用的说明文件写得不对，装不了；让 Ash 帮你改好，改好之后它会出现在这里。", bad.troubleText)
        val grantedBad = list("""[{"id":"x","enabled":true,"granted":true,"error":"app.json /id: id 是 y，但文件夹叫 x","problem":"manifest"}]""").single()
        assertTrue(grantedBad.broken); assertFalse("an installed app with a broken manifest cannot be opened", grantedBad.usable)
        assertEquals("这个应用的说明文件写得不对，打不开；可以点「收回全部权限」把它卸掉。", grantedBad.troubleText)
        for (a in listOf(bad, grantedBad)) assertFalse("no file name or parser line in what the owner reads", Regex("app\\.json|JSON|Unexpected|/id").containsMatchIn(a.troubleText!!))
    }

    @Test fun anOlderKernelThatGivesNoKindStillNeverShowsItsLine() {
        val notInstalled = list("""[{"id":"x","enabled":false,"granted":false,"error":"app.json: x"}]""").single()
        assertTrue(notInstalled.broken)
        val running = list("""[{"id":"y","enabled":true,"granted":true,"error":"start failed: ENOENT"}]""").single()
        assertFalse(running.broken); assertTrue(running.usable)
        assertEquals("这个应用没能正常跑起来；重新打开试试，还不行可以让 Ash 看看原因，或点「收回全部权限」把它卸掉。", running.troubleText)
        val gone = list("""[{"id":"z","enabled":true,"granted":true,"error":"应用文件夹不在了","problem":"folder"}]""").single()
        assertEquals("这个应用的文件夹已经不在了，只剩安装记录；可以点「收回全部权限」把它卸掉。", gone.troubleText)
        assertNull(list("""[{"id":"w","enabled":true,"granted":true}]""").single().troubleText)
    }
}
