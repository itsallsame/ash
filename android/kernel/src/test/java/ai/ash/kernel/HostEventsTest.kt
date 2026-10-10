package ai.ash.kernel

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class HostEventsTest {
    private fun parse(line: String): JSONObject {
        assertFalse("one line per event", line.contains('\n'))
        return JSONObject(line)
    }

    @Test fun wakeFired() {
        val e = parse(HostEvents.wakeFired(1791234567000))
        assertEquals("wake.fired", e.getString("event"))
        assertEquals(1791234567000L, e.getLong("at"))
        assertEquals(2, e.length())
    }

    @Test fun networkChangedWithoutAndWithProxy() {
        val none = parse(HostEvents.networkChanged(null, true))
        assertEquals("env.changed", none.getString("event"))
        assertEquals("network", none.getString("what"))
        assertTrue(none.getJSONObject("network").isNull("proxy"))
        assertTrue(none.getBoolean("online"))

        val set = parse(HostEvents.networkChanged(Proxy("http://h:1", "http://h:1", "localhost"), false))
        val proxy = set.getJSONObject("network").getJSONObject("proxy")
        assertEquals("http://h:1", proxy.getString("http"))
        assertEquals("http://h:1", proxy.getString("https"))
        assertEquals("localhost", proxy.getString("no_proxy"))
        assertFalse(set.getBoolean("online"))
    }

    @Test fun powerChanged() {
        val e = parse(HostEvents.powerChanged(true))
        assertEquals("env.changed", e.getString("event"))
        assertEquals("power", e.getString("what"))
        assertTrue(e.getBoolean("saver"))
        assertEquals(3, e.length())
    }

    @Test fun lifecycleStop() {
        val e = parse(HostEvents.lifecycleStop(1791234597000, "system_shutdown"))
        assertEquals("lifecycle.stop", e.getString("event"))
        assertEquals(1791234597000L, e.getLong("deadline"))
        assertEquals("system_shutdown", e.getString("reason"))
    }

    // ---- the pipe: events become lines on the child's standard input, its output lands in the log

    private val dir = tempDir("kernel-node")

    @After fun cleanup() { dir.deleteRecursively() }

    @Test fun eventsReachTheChildAsJsonLinesAndItsOutputIsLogged() {
        val log = RotatingLog(dir)
        // `cat` stands in for the core: whatever arrives on stdin comes back on stdout, which goes to the log.
        val node = NodeProcess.start(listOf("cat"), mapOf("PATH" to System.getenv("PATH")!!), dir, log, File(dir, "node.pid"), NoSignals)
        assertTrue(node.isRunning())
        assertTrue(node.writeEvent(HostEvents.wakeFired(5)))
        assertTrue(node.writeEvent(HostEvents.networkChanged(null, true)))
        assertTrue(node.writeEvent(HostEvents.powerChanged(false)))
        assertTrue(node.writeEvent(HostEvents.lifecycleStop(9, "restart")))
        val file = File(dir, "core.log")
        var text = ""
        for (i in 0 until 100) {
            text = if (file.exists()) file.readText() else ""
            if (text.lines().count { it.isNotBlank() } >= 4) break
            Thread.sleep(50)
        }
        val lines = text.lines().filter { it.isNotBlank() }.map { JSONObject(it) }
        assertEquals(listOf("wake.fired", "env.changed", "env.changed", "lifecycle.stop"), lines.map { it.getString("event") })
        assertEquals(listOf("", "network", "power", ""), lines.map { it.optString("what") })
        node.stop(null, 0)
        // A closed stdin ends cat; a stopped child no longer takes events.
        for (i in 0 until 100) { if (!node.isRunning()) break; Thread.sleep(50) }
    }

    @Test fun stopWritesTheStopLineAndWaitsForACleanExit() {
        val log = RotatingLog(dir)
        // sh reads one line and exits 0 when it sees it: a core that shuts down on lifecycle.stop.
        val node = NodeProcess.start(listOf("sh", "-c", "read line; echo \"got \$line\""), mapOf("PATH" to System.getenv("PATH")!!), dir, log, null, NoSignals)
        val line = HostEvents.lifecycleStop(System.currentTimeMillis() + 5000, "restart")
        node.stop(line, 5_000)
        assertFalse(node.isRunning())
        Thread.sleep(200)
        assertTrue(File(dir, "core.log").readText().contains("got $line"))
    }

    /** JVM signals through kill(1) (the Android build uses kill(2)). */
    private object NoSignals : ProcessSignals {
        private fun sig(name: String, pid: Int) = ProcessBuilder("kill", "-$name", pid.toString()).redirectErrorStream(true).start().waitFor()
        override fun term(pid: Int) { sig("TERM", pid) }
        override fun kill(pid: Int) { sig("KILL", pid) }
        override fun alive(pid: Int) = sig("0", pid) == 0
    }
}
