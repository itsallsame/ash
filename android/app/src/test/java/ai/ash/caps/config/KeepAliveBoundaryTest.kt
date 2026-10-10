package ai.ash.caps.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The keep-alive switch flow drives the phone maker's settings through accessibility. Two doors lead to it, and only
 * these: the owner's tap on a permission entry, and the capability `config.keepalive.fix`, whose risk makes the kernel
 * ask the owner first.
 */
class KeepAliveBoundaryTest {
    private val sources = listOf("src/main/java")
        .map(::File).filter { it.isDirectory }.flatMap { dir -> dir.walk().filter { it.extension == "kt" }.toList() }

    @Test fun onlyTheCapabilityAndTheOwnersTapRunTheFlow() {
        assertTrue("no sources found", sources.isNotEmpty())
        val users = sources.filter { Regex("""KeepAliveFix\.run""").containsMatchIn(it.readText()) }.map { it.name }.toSet()
        assertEquals(setOf("KeepAliveFlow.kt", "ConfigCapabilities.kt"), users)
    }

    @Test fun theFlowIsStartedOnlyFromPermissionEntries() {
        val users = sources.filter { Regex("""KeepAliveFlow\.""").containsMatchIn(it.readText()) }.map { it.name }.toSet()
        assertEquals(setOf("Permissions.kt"), users)
    }

    @Test fun theCapabilityAsksTheOwnerFirst() {
        val fix = ai.ash.caps.Capabilities.byName.getValue("config.keepalive.fix")
        assertEquals("structure", fix.risk)
        assertTrue(fix.foreground)
    }
}
