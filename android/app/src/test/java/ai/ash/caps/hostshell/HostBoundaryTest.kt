package ai.ash.caps.hostshell

import ai.ash.caps.Capabilities
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The hand app holds no high-privilege parts: the debug identity is the kernel's own host layer now (see the kernel's
 * host boundary test). What is checked here is what stays the app's: it writes no secure or global setting, it runs no
 * command and switches no host service, and the door that the kernel host hands its binder to is guarded.
 */
class HostBoundaryTest {
    private val sources = File("src/main/java").walk().filter { it.extension == "kt" || it.extension == "java" }.toList()
    private val manifest = File("src/main/AndroidManifest.xml").readText()

    @Test fun ashWritesNoSecureOrGlobalSetting() {
        assertTrue("no sources found", sources.isNotEmpty())
        val write = Regex("""Settings\.(Secure|Global)\.put\w*\(|content://settings/(secure|global)""")
        assertEquals(emptyList<String>(), sources.filter { write.containsMatchIn(it.readText()) }.map { it.name })
        assertFalse("the app does not ask for WRITE_SECURE_SETTINGS", manifest.contains("WRITE_SECURE_SETTINGS"))
    }

    @Test fun onlySettingsPutWritesASystemSetting() {
        val write = Regex("""Settings\.System\.put\w*\(""")
        assertEquals(listOf("SystemCapabilities.kt"), sources.filter { write.containsMatchIn(it.readText()) }.map { it.name })
        assertEquals("structure", Capabilities.byName.getValue("settings.put").risk)
    }

    @Test fun noCapabilityRunsACommandOnTheHostOrSwitchesAHostService() {
        for (gone in listOf("shell.run", "shell.status", "config.keepalive.fix", "config.accessibility.enable")) {
            assertFalse(gone, gone in Capabilities.byName)
        }
    }

    @Test fun theAppHoldsNoDebugIdentityOfItsOwn() {
        // No pairing, no shell host, no native pairing library in the app any more: those moved to the kernel package.
        for (gone in listOf("Server.java", "HostShellGuide.kt", "adb")) {
            assertFalse(gone, File("src/main/java/ai/ash/caps/hostshell/$gone").exists())
        }
        assertFalse("no pairing native source", File("src/main/jni").exists())
    }

    @Test fun theDoorTakesTheBinderOnlyFromTheShellAndIsGuarded() {
        val door = File("src/main/java/ai/ash/caps/hostshell/HostShellDoor.kt").readText()
        assertTrue(door.contains("uid != Process.SHELL_UID && uid != 0"))
        val entry = Regex("""<provider\s[^>]*HostShellDoor[^>]*>""", RegexOption.DOT_MATCHES_ALL).find(manifest)?.value.orEmpty()
        assertTrue(entry.contains("android.permission.INTERACT_ACROSS_USERS_FULL"))
    }

    @Test fun theAppNeverTurnsWirelessDebuggingOnOrOff() {
        val adbSetting = Regex(""""adb_wifi_enabled"|"adb_enabled"|"adb_allowed_connection_time"""")
        val writers = sources.filter { f -> f.readText().lines().any { adbSetting.containsMatchIn(it) && it.contains("put") } }.map { it.name }
        assertEquals(emptyList<String>(), writers)
    }
}
