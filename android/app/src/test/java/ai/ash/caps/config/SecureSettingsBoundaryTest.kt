package ai.ash.caps.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Ash holds WRITE_SECURE_SETTINGS for one thing: bringing its accessibility service back. Android grants
 * it whole, so the boundary is kept here, in code: one file writes secure settings, only the accessibility keys, only
 * Ash's own accessibility entry, and the only capability that reaches it is the gated config.accessibility.enable.
 */
class SecureSettingsBoundaryTest {
    private val sources = listOf("src/main/java")
        .map(::File).filter { it.isDirectory }.flatMap { dir -> dir.walk().filter { it.extension == "kt" || it.extension == "java" }.toList() }
    private val write = Regex("""Settings\.(Secure|Global)\.put\w*\(|\.putString\(\s*resolver|content://settings/(secure|global)""")

    @Test fun onlyRecoveryWritesSecureOrGlobalSettings() {
        assertTrue("no sources found", sources.isNotEmpty())
        val writers = sources.filter { write.containsMatchIn(it.readText()) }.map { it.name }.toSet()
        assertEquals(setOf("ScreenRecovery.kt"), writers)
    }

    @Test fun recoveryWritesOnlyTheAccessibilityKeys() {
        val recovery = sources.single { it.name == "ScreenRecovery.kt" }.readText()
        val keys = Regex("""Settings\.Secure\.put\w*\(\s*resolver\s*,\s*([\w.]+)""").findAll(recovery).map { it.groupValues[1] }.toSet()
        assertEquals(setOf("key", "Settings.Secure.ACCESSIBILITY_ENABLED"), keys)
        assertTrue(recovery.contains("val key = Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES"))
    }

    @Test fun onlyOneCapabilityReachesRecoveryAndItIsGated() {
        // Outside caps/config nothing names it; inside, only the capability config.accessibility.enable (and the screens the owner uses) do.
        val tools = sources.filter { f -> f.path.contains("/ai/ash/caps/") && !f.path.contains("/ai/ash/caps/config/") }
        // A call or an import, not a mention in a comment.
        val use = Regex("""ScreenRecovery\.|import\s+ai\.ash\.caps\.config\.ScreenRecovery""")
        assertFalse(tools.filter { use.containsMatchIn(it.readText()) }.map { it.name }.toString(), tools.any { use.containsMatchIn(it.readText()) })
        val inside = sources.filter { it.path.contains("/ai/ash/caps/config/") && Regex("""ScreenRecovery\.enable""").containsMatchIn(it.readText()) }.map { it.name }.toSet()
        assertEquals(setOf("ConfigCapabilities.kt"), inside)
        // Writing a secure setting is a structural change: the kernel's gate asks the owner.
        assertEquals("structure", ai.ash.caps.Capabilities.byName.getValue("config.accessibility.enable").risk)
    }

    @Test fun enablingAddsOnlyAshsOwnEntry() {
        val own = "ai.ash.agent/ai.ash.caps.screen.A11yService"
        assertEquals("com.other/.Reader:$own", ScreenRecovery.Services.withHelperAdded("com.other/.Reader", own))
        assertEquals(own, ScreenRecovery.Services.withHelperAdded("", own))
        // Once is enough.
        assertEquals("com.other/.Reader:$own", ScreenRecovery.Services.withHelperAdded("com.other/.Reader:$own", own))
    }

    @Test fun onlyAshsEntryIsTakenOutAndPutBack() {
        val pkg = "ai.ash.agent"
        val list = "com.other/.Reader:ai.ash.agent/ai.ash.caps.screen.A11yService:com.third/.Svc"
        assertEquals(listOf("ai.ash.agent/ai.ash.caps.screen.A11yService"), ScreenRecovery.Services.helpers(list, pkg))
        val without = ScreenRecovery.Services.withoutHelper(list, pkg)
        assertEquals("com.other/.Reader:com.third/.Svc", without)
        assertEquals("com.other/.Reader:com.third/.Svc:ai.ash.agent/ai.ash.caps.screen.A11yService", ScreenRecovery.Services.withHelperBack(without, list, pkg))
        // Never adds Ash's entry unless the owner had it on; a look-alike package is not Ash.
        assertEquals("com.other/.Reader", ScreenRecovery.Services.withHelperBack("com.other/.Reader", "com.other/.Reader", pkg))
        assertEquals(emptyList<String>(), ScreenRecovery.Services.helpers("ai.ash.agentfake/.X", pkg))
    }
}
