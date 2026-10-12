package ai.ash.kernel.host

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The kernel's host layer is the one high-privilege thing. What it offers the hand app (the phone-action whitelist) is a
 * short, fixed list run as fixed programs, never a command line; the kernel bridge, through which the shell host reaches
 * the package's identity, and the whitelist are both refused unless the caller is the shell (or the hand app). The shell
 * host writes no secure or global setting and never turns wireless debugging on or off.
 */
class HostBoundaryTest {
    private val sources = File("src/main/java").walk().filter { it.extension == "kt" || it.extension == "java" }.toList()
    private val manifest = File("src/main/AndroidManifest.xml").readText()

    @Test fun theWhitelistOffersOnlyItsShortList() {
        val aidl = File("src/main/aidl/ai/ash/caps/hostshell/IHostShell.aidl").readText()
        val methods = Regex("""^\s*[\w.<>\[\]]+\s+(\w+)\(""", RegexOption.MULTILINE).findAll(aidl).map { it.groupValues[1] }.toSet()
        assertEquals(setOf("build", "openVscreen", "key", "start", "frontApp", "exit"), methods)
    }

    @Test fun theWhitelistRunsOnlyFixedProgramsNeverAShell() {
        val actions = File("src/main/java/ai/ash/kernel/host/PhoneActions.java").readText()
        assertFalse(actions.contains("/system/bin/sh"))
        assertFalse(Regex(""""sh"\s*,\s*"-c"""").containsMatchIn(actions))
        assertFalse(actions.contains("Runtime.getRuntime().exec"))
        val programs = Regex(""""(/system/bin/\w+)"""").findAll(actions).map { it.groupValues[1] }.toSet()
        assertEquals(setOf("/system/bin/app_process", "/system/bin/input", "/system/bin/am", "/system/bin/dumpsys"), programs)
    }

    @Test fun everyWhitelistCallIsCheckedForTheHandUid() {
        for (name in listOf("PhoneActions.java", "ServerProcess.java")) {
            val text = File("src/main/java/ai/ash/kernel/host/$name").readText()
            assertTrue(name, Regex("""onTransact\([^)]*\)[^{]*\{\s*(final\s+)?int\s+\w+\s*=\s*Binder\.getCallingUid\(\);[^}]*Binder\.getCallingUid\(\)\s*!=|if \(code >= FIRST_CALL_TRANSACTION[^}]*Binder\.getCallingUid\(\) != \w+\)""").containsMatchIn(text))
        }
    }

    @Test fun theBridgeAndDoorTakeCallsOnlyFromTheShell() {
        val bridge = File("src/main/java/ai/ash/kernel/host/KernelBridge.kt").readText()
        assertTrue(bridge.contains("Process.SHELL_UID") && bridge.contains("!= 0"))
        val door = File("src/main/java/ai/ash/kernel/host/KernelHostDoor.kt").readText()
        assertTrue(door.contains("uid != Process.SHELL_UID && uid != 0"))
        val entry = Regex("""<provider\s[^>]*KernelHostDoor[^>]*>""", RegexOption.DOT_MATCHES_ALL).find(manifest)?.value.orEmpty()
        assertTrue(entry.contains("android.permission.INTERACT_ACROSS_USERS_FULL"))
    }

    @Test fun theShellHostWritesNoSecureSettingAndDoesNotTouchWirelessDebugging() {
        // Only writes are a boundary; the pairing guide reads adb_wifi_enabled to know the switch state, which is fine.
        val write = Regex("""Settings\.(Secure|Global|System)\.put\w*\(""")
        assertEquals(emptyList<String>(), sources.filter { write.containsMatchIn(it.readText()) }.map { it.name })
        val adbWrite = Regex("""put\w*\([^)]*"adb_(wifi_enabled|enabled|allowed_connection_time)"""")
        assertEquals(emptyList<String>(), sources.filter { adbWrite.containsMatchIn(it.readText()) }.map { it.name })
        assertFalse("the kernel does not ask for WRITE_SECURE_SETTINGS", manifest.contains("WRITE_SECURE_SETTINGS"))
    }

    @Test fun theCoreIsLaunchedThroughRunAs() {
        val launcher = File("src/main/java/ai/ash/kernel/host/ShellNodeLauncher.kt").readText()
        assertTrue("the core runs via run-as (outside the package cgroup)", launcher.contains("/system/bin/run-as"))
    }
}
