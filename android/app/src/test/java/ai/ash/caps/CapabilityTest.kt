package ai.ash.caps

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CapabilityTest {
    @Test fun aResultSchemaListsItsFieldsAndWhichOnesAlwaysComeBack() {
        val r = result("steps:integer!", "since:integer", "value:string?")
        assertEquals("object", r.getString("type"))
        assertEquals(listOf("steps"), (0 until r.getJSONArray("required").length()).map { r.getJSONArray("required").getString(it) })
        assertEquals("integer", r.getJSONObject("properties").getJSONObject("since").getString("type"))
        val nullable = r.getJSONObject("properties").getJSONObject("value").getJSONArray("anyOf")
        assertEquals(setOf("string", "null"), (0 until nullable.length()).map { nullable.getJSONObject(it).getString("type") }.toSet())
        assertTrue(r.getBoolean("additionalProperties"))
    }

    @Test fun aCapabilityMustNameAnEffectAndARiskTheLinkKnows() {
        assertThrows(IllegalArgumentException::class.java) { Cap("x.a.b", "d", effect = "send", risk = Risk.NONE, label = "l") { _, _ -> CapResult.text("ok") } }
        assertThrows(IllegalArgumentException::class.java) { Cap("x.a.b", "d", effect = Effect.READ, risk = "high", label = "l") { _, _ -> CapResult.text("ok") } }
    }

    @Test fun theRegistryHasNoNameTwiceAndEveryNameFindsItsCapability() {
        for (c in Capabilities.all) assertEquals(c, Capabilities.byName[c.name])
    }

    @Test fun theSpecCarriesWhatTheCapabilityDeclares() {
        val tap = Manifest.spec(Capabilities.byName.getValue("screen.tap"))
        assertEquals("act", tap.getString("effect"))
        assertEquals("outward", tap.getString("risk"))
        assertTrue(tap.getBoolean("foreground"))
        assertEquals("在点屏幕", tap.getString("label"))
        val read = Manifest.spec(Capabilities.byName.getValue("screen.read"))
        assertTrue(!read.has("foreground"))
        assertTrue(!read.has("callers"))
        val decision = Manifest.spec(Capabilities.byName.getValue("decision.surface"))
        assertEquals(listOf("kernel"), (0 until decision.getJSONArray("callers").length()).map { decision.getJSONArray("callers").getString(it) })
    }

    @Test fun onlyTheScreenInputCapabilitiesPassUnderTheIsland() {
        val passing = Capabilities.all.filter { it.overlay == Overlay.PASSTHROUGH }.map { it.name }.toSet()
        assertEquals(setOf("screen.tap", "screen.type", "screen.scroll", "screen.swipe", "screen.hold", "screen.touch", "screen.gesture",
            "screen.global_action", "apps.open_direct", "apps.open_url", "settings.open"), passing)
        assertEquals(listOf("screen.see"), Capabilities.all.filter { it.overlay == Overlay.HIDDEN }.map { it.name })
    }
}
