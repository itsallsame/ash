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

    // ---- the pipe: the secrets and events become lines on the child's standard input, its output lines come back to the
    // host, its standard error lands in the log

    private val dir = tempDir("kernel-node")

    @After fun cleanup() { dir.deleteRecursively() }

    @Test fun theSecretsComeFirstThenEventsAndTheChildsOutputComesBackLineByLine() {
        val log = RotatingLog(dir)
        val back = java.util.Collections.synchronizedList(ArrayList<String>())
        // `cat` stands in for the core: whatever arrives on stdin comes back on stdout, which is handed back line by line.
        val node = NodeProcess.start(listOf("cat"), mapOf("PATH" to System.getenv("PATH")!!), dir, log, File(dir, "node.pid"),
            HostPipe.bootLine("k3y"), { _, line -> back += line }, NoSignals)
        assertTrue(node.isRunning())
        assertTrue(node.writeEvent(HostEvents.wakeFired(5)))
        assertTrue(node.writeEvent(HostEvents.networkChanged(null, true)))
        assertTrue(node.writeEvent(HostEvents.powerChanged(false)))
        assertTrue(node.writeEvent(HostEvents.lifecycleStop(9, "restart")))
        for (i in 0 until 100) { if (back.size >= 5) break; Thread.sleep(50) }
        val lines = back.map { JSONObject(it) }
        assertEquals("k3y", lines[0].getJSONObject("boot").getString("seal_key"))
        assertEquals(listOf("wake.fired", "env.changed", "env.changed", "lifecycle.stop"), lines.drop(1).map { it.getString("event") })
        assertEquals(listOf("", "network", "power", ""), lines.drop(1).map { it.optString("what") })
        assertFalse("standard output is not the log", File(dir, "core.log").let { it.exists() && it.readText().contains("k3y") })
        node.stop(null, 0)
        // A closed stdin ends cat; a stopped child no longer takes events.
        for (i in 0 until 100) { if (!node.isRunning()) break; Thread.sleep(50) }
    }

    @Test fun stopWritesTheStopLineAndWaitsForACleanExit() {
        val log = RotatingLog(dir)
        // sh reads the secrets, then one line, and exits 0 when it sees it: a core that shuts down on lifecycle.stop. It
        // writes on standard error, the core's log.
        val node = NodeProcess.start(listOf("sh", "-c", "read boot; read line; echo \"got \$line\" >&2"), mapOf("PATH" to System.getenv("PATH")!!), dir, log, null,
            HostPipe.bootLine("k"), { _, _ -> }, NoSignals)
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
