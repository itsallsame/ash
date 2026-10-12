package ai.ash.caps.hostshell

import ai.ash.caps.Capabilities
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The line between the host's services and Ash's tools, kept in code. The owner grants and switches the host's services
 * (accessibility, wireless debugging and the debug identity, the maker's keep-alive switches, secure settings); Ash only
 * reads them and puts the right page in front of the owner. What Ash may do with the debug identity is the short list of
 * [IHostShell], each a fixed program: never a command of its own.
 */
class HostBoundaryTest {
    private val sources = File("src/main/java").walk().filter { it.extension == "kt" || it.extension == "java" }.toList()
    private val manifest = File("src/main/AndroidManifest.xml").readText()

    @Test fun ashWritesNoSecureOrGlobalSetting() {
        assertTrue("no sources found", sources.isNotEmpty())
        val write = Regex("""Settings\.(Secure|Global)\.put\w*\(|content://settings/(secure|global)""")
        assertEquals(emptyList<String>(), sources.filter { write.containsMatchIn(it.readText()) }.map { it.name })
        assertFalse("Ash does not ask for WRITE_SECURE_SETTINGS", manifest.contains("WRITE_SECURE_SETTINGS"))
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

    @Test fun theServiceOffersOnlyItsShortList() {
        val aidl = File("src/main/aidl/ai/ash/caps/hostshell/IHostShell.aidl").readText()
        val methods = Regex("""^\s*[\w.<>\[\]]+\s+(\w+)\(""", RegexOption.MULTILINE).findAll(aidl).map { it.groupValues[1] }.toSet()
        assertEquals(setOf("build", "openVscreen", "key", "start", "frontApp", "exit"), methods)
    }

    @Test fun theServiceRunsOnlyFixedProgramsNeverAShell() {
        val server = File("src/main/java/ai/ash/caps/hostshell/Server.java").readText()
        assertFalse(server.contains("/system/bin/sh"))
        assertFalse(Regex(""""sh"\s*,\s*"-c"""").containsMatchIn(server))
        assertFalse(server.contains("Runtime.getRuntime().exec"))
        // Every program it starts is named in the file.
        val programs = Regex(""""(/system/bin/\w+)"""").findAll(server).map { it.groupValues[1] }.toSet()
        assertEquals(setOf("/system/bin/app_process", "/system/bin/input", "/system/bin/am", "/system/bin/dumpsys", "/system/bin/setsid"), programs)
    }

    @Test fun everyCallIsCheckedForAshsUid() {
        for (name in listOf("Server.java", "ServerProcess.java")) {
            val text = File("src/main/java/ai/ash/caps/hostshell/$name").readText()
            assertTrue(name, Regex("""public boolean onTransact\([^)]*\)[^{]*\{\s*if \(code >= FIRST_CALL_TRANSACTION && code <= LAST_CALL_TRANSACTION && Binder\.getCallingUid\(\) != \w+\)""").containsMatchIn(text))
        }
    }

    @Test fun theDoorTakesTheServiceOnlyFromTheShellAndIsGuarded() {
        val door = File("src/main/java/ai/ash/caps/hostshell/HostShellDoor.kt").readText()
        assertTrue(door.contains("uid != Process.SHELL_UID && uid != 0"))
        val entry = Regex("""<provider\s[^>]*HostShellDoor[^>]*>""", RegexOption.DOT_MATCHES_ALL).find(manifest)?.value.orEmpty()
        assertTrue(entry.contains("android.permission.INTERACT_ACROSS_USERS_FULL"))
    }

    @Test fun ashNeverTurnsWirelessDebuggingOnOrOff() {
        val adbSetting = Regex(""""adb_wifi_enabled"|"adb_enabled"|"adb_allowed_connection_time"""")
        val writers = sources.filter { f -> f.readText().lines().any { adbSetting.containsMatchIn(it) && it.contains("put") } }.map { it.name }
        assertEquals(emptyList<String>(), writers)
    }
}
