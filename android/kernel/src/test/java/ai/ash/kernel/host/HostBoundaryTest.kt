package ai.ash.kernel.host

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The kernel's host layer is the one high-privilege thing. What it offers the core (service:host's phone actions) is a
 * short, fixed list run as fixed programs, never a command line; on the kernel package's own identity only media and
 * volume keys. The kernel bridge, through which the shell host reaches the package's identity, is refused unless the
 * caller is the shell. The shell host writes no secure or global setting and never turns wireless debugging on or off.
 */
class HostBoundaryTest {
    private val sources = File("src/main/java").walk().filter { it.extension == "kt" || it.extension == "java" }.toList()
    private val manifest = File("src/main/AndroidManifest.xml").readText()
    private fun src(path: String) = File("src/main/java/ai/ash/kernel/$path").readText()
    private fun actions(text: String) = Regex("""^\s*"([a-z_]+(?:\.[a-z_]+)+)" ->""", RegexOption.MULTILINE).findAll(text.substringAfter("override fun call(").substringBefore("\n    }\n"))
        .map { it.groupValues[1] }.toSet()

    @Test fun theShellHostOffersOnlyItsShortList() {
        val vscreen = setOf("create", "status", "launch", "see", "tap", "swipe", "key", "type", "close", "record.start", "record.stop").map { "vscreen.$it" }
        assertEquals((vscreen + "input.key" + "apps.open").toSet(), actions(src("host/ShellPhone.kt")))
    }

    @Test fun onItsOwnIdentityTheKernelOffersOnlyMediaAndVolumeKeys() {
        assertEquals(setOf("input.key"), actions(src("host/AppPhone.kt")))
        val service = src("KernelService.kt")
        assertTrue(service.contains("HostApi.CAPABILITIES + \"input\"") && service.contains("AppPhone(this)"))
        assertTrue(src("host/ShellHost.kt").contains("listOf(\"vscreen\", \"input\", \"apps\")"))
    }

    @Test fun thePhoneActionsRunOnlyFixedProgramsNeverAShell() {
        val phone = src("host/ShellPhone.kt")
        assertFalse(phone.contains("/system/bin/sh"))
        assertFalse(Regex(""""sh"\s*,\s*"-c"""").containsMatchIn(phone))
        assertFalse(phone.contains("Runtime.getRuntime().exec"))
        val programs = Regex(""""(/system/bin/\w+)"""").findAll(phone).map { it.groupValues[1] }.toSet()
        assertEquals(setOf("/system/bin/app_process", "/system/bin/input", "/system/bin/am", "/system/bin/dumpsys"), programs)
    }

    @Test fun theVirtualScreenProgramIsTheKernelsOwn() {
        assertTrue(File("src/main/java/ai/ash/kernel/host/vscreen/Main.java").exists())
        assertTrue(src("host/ShellPhone.kt").contains("\"ai.ash.kernel.host.vscreen.Main\""))
        assertFalse("no binder is handed to the hand app any more", File("src/main/aidl/ai/ash/caps").exists())
    }

    @Test fun theBridgeAndDoorTakeCallsOnlyFromTheShell() {
        val bridge = src("host/KernelBridge.kt")
        assertTrue(bridge.contains("Process.SHELL_UID") && bridge.contains("!= 0"))
        val door = src("host/KernelHostDoor.kt")
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

    @Test fun theHostStopsAndExitsWhenTheKernelPackageGoes() {
        // An upgrade replaces the kernel package; the new kernel service starts a core. This host must not leave a second
        // one running: it watches the bridge binder and, when it dies, stops its core and exits.
        val host = src("host/ShellHost.kt")
        assertTrue(host.contains("bridgeBinder.linkToDeath"))
        val onDeath = host.substringAfter("linkToDeath").substringBefore("}, 0)")
        assertTrue(onDeath.contains("supervisor.shutdown") && onDeath.contains("System.exit"))
    }

    @Test fun theCoreIsLaunchedThroughRunAs() {
        assertTrue("the core runs via run-as (outside the package cgroup)", src("host/ShellNodeLauncher.kt").contains("/system/bin/run-as"))
    }

    @Test fun theFrontPackageComesFromTheResumedActivityFirst() {
        val dump = """
            topResumedActivity=ActivityRecord{1a2b3c u0 com.taobao.taobao/.homepage.MainActivity3 t812}
              mResumedActivity: ActivityRecord{9f u0 com.other.app/.Old t7}
              mCurrentFocus=Window{44 u0 com.focus.app/com.focus.app.Main}
        """.trimIndent()
        assertEquals("com.taobao.taobao", ShellPhone.frontOf(dump))
        assertEquals("com.miui.home", ShellPhone.frontOf("  mCurrentFocus=Window{12ab u0 com.miui.home/com.miui.home.launcher.Launcher}"))
        assertEquals("com.android.settings", ShellPhone.frontOf("  mFocusedApp=ActivityRecord{7 u0 com.android.settings/.Settings t3}"))
        assertNull(ShellPhone.frontOf(""))
        assertNull(ShellPhone.frontOf("  mCurrentFocus=null"))
    }
}
