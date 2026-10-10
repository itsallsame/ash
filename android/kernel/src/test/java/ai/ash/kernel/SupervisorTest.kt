package ai.ash.kernel

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SupervisorTest {
    private val clock = FakeClock()
    private val launcher = FakeLauncher(clock)
    private val provisioner = FakeProvisioner()
    private val env = FakeEnv()
    private var stopped = false
    private val shown = ArrayList<String>()
    private val notes = ArrayList<String>()
    private var gone = 0
    private val sup = KernelSupervisor(
        clock, provisioner, launcher, env, { stopped }, { shown += it }, { notes += it }, { gone++ },
    )

    /** One tick, then let [ms] pass. */
    private fun tick(ms: Long = 5_000) { sup.tick(); clock.advance(ms) }

    private fun crash() { launcher.launched.last().running = false }

    // ---- the backoff itself

    @Test fun backoffDoublesFromFiveSecondsToFiveMinutes() {
        assertEquals(listOf(5_000L, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000), (1..9).map { RestartBackoff.delayMs(it) })
    }

    // ---- restarts after crashes

    @Test fun crashesAreRestartedWithGrowingDelay() {
        sup.tick()
        assertEquals(1, launcher.launched.size)
        val gaps = ArrayList<Long>()
        repeat(8) {
            crash()
            val crashedAt = clock.now()
            sup.tick() // notices the exit; the backoff runs from here
            while (launcher.launched.size < it + 2) { clock.advance(1_000); sup.tick() }
            gaps += launcher.launchTimes.last() - crashedAt
        }
        // Each gap is the backoff plus at most one second of polling resolution.
        val expected = listOf(5_000L, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000)
        gaps.zip(expected).forEach { (gap, want) -> assertTrue("gap $gap vs $want", gap in want..want + 1_000) }
        assertEquals(8, gone)
    }

    @Test fun aStableRunClearsTheBackoff() {
        sup.tick()
        repeat(3) {
            crash()
            sup.tick()
            while (launcher.launched.size < it + 2) { clock.advance(1_000); sup.tick() }
        }
        // 4th start. It runs 10 minutes, then dies: the next restart is the first step again.
        clock.advance(10 * 60_000)
        crash()
        val crashedAt = clock.now()
        sup.tick()
        assertEquals(4, launcher.launched.size)
        while (launcher.launched.size < 5) { clock.advance(1_000); sup.tick() }
        val gap = launcher.launchTimes.last() - crashedAt
        assertTrue("gap $gap", gap in 5_000L..6_000L)
    }

    @Test fun aRunUnderTenMinutesKeepsTheBackoff() {
        sup.tick()
        crash()
        while (launcher.launched.size < 2) { clock.advance(1_000); sup.tick() } // 5 s
        clock.advance(9 * 60_000)
        crash()
        val crashedAt = clock.now()
        while (launcher.launched.size < 3) { clock.advance(1_000); sup.tick() }
        assertTrue(launcher.launchTimes.last() - crashedAt >= 10_000)
    }

    @Test fun aLaunchThatFailsIsRetriedWithTheSameBackoff() {
        launcher.failNext = 2
        sup.tick() // fails
        assertEquals(0, launcher.launched.size)
        assertTrue(shown.last().startsWith("出错"))
        clock.advance(4_000); sup.tick()
        assertEquals(0, launcher.launched.size) // still inside the 5 s wait
        clock.advance(1_500); sup.tick() // fails again, 10 s wait
        clock.advance(9_000); sup.tick()
        assertEquals(0, launcher.launched.size)
        clock.advance(1_500); sup.tick()
        assertEquals(1, launcher.launched.size)
    }

    // ---- heartbeat

    @Test fun silenceAfterReadyKillsTheCoreAfter180Seconds() {
        sup.tick()
        val node = launcher.launched.last()
        sup.onReady("0.4.0", 43999)
        clock.advance(179_000); sup.tick()
        assertTrue(node.running)
        sup.onActivity() // any host call counts
        clock.advance(179_000); sup.tick()
        assertTrue(node.running)
        clock.advance(2_000); sup.tick()
        assertFalse("killed", node.running)
        assertNull("no graceful stop line for a hung core", node.stopLine)
        // And it comes back.
        while (launcher.launched.size < 2) { clock.advance(1_000); sup.tick() }
        assertTrue(launcher.launched.last().running)
    }

    @Test fun aCoreThatNeverSaidReadyIsNotWatched() {
        sup.tick()
        clock.advance(30 * 60_000); sup.tick()
        assertTrue(launcher.launched.last().running)
    }

    @Test fun heartbeatsBeforeReadyDoNotArmTheWatch() {
        sup.tick()
        sup.onActivity()
        clock.advance(600_000); sup.tick()
        assertTrue(launcher.launched.last().running)
    }

    @Test fun aNewCoreStartsUnwatchedAgain() {
        sup.tick()
        sup.onReady("0.4.0", 1)
        crash()
        while (launcher.launched.size < 2) { clock.advance(1_000); sup.tick() }
        clock.advance(600_000); sup.tick()
        assertTrue(launcher.launched.last().running) // not ready yet, so not expired
    }

    // ---- environment: told, not restarted

    @Test fun proxyChangeSendsEnvChangedAndDoesNotRestart() {
        sup.tick()
        val node = launcher.launched.last()
        clock.advance(5_000); sup.tick()
        assertTrue(node.events.isEmpty())
        env.proxy = Proxy.of("10.0.0.2:8080")
        clock.advance(5_000); sup.tick()
        assertEquals(1, node.events.size)
        val e = JSONObject(node.events[0])
        assertEquals("env.changed", e.getString("event"))
        assertEquals("network", e.getString("what"))
        assertEquals("http://10.0.0.2:8080", e.getJSONObject("network").getJSONObject("proxy").getString("http"))
        assertTrue(node.running)
        assertEquals(1, launcher.launched.size)
        // Unchanged: nothing more is sent. Going offline is a change.
        clock.advance(5_000); sup.tick()
        assertEquals(1, node.events.size)
        env.online = false
        clock.advance(5_000); sup.tick()
        assertEquals(2, node.events.size)
        assertFalse(JSONObject(node.events[1]).getBoolean("online"))
        assertEquals(1, launcher.launched.size)
    }

    // ---- requests

    @Test fun restartRequestStopsGracefullyAndStartsAtOnceWithoutBackoff() {
        sup.tick()
        val first = launcher.launched.last()
        sup.onReady("0.4.0", 1)
        sup.onRestart("settings changed")
        sup.tick()
        assertFalse(first.running)
        assertEquals("lifecycle.stop", JSONObject(first.stopLine!!).getString("event"))
        assertEquals("restart", JSONObject(first.stopLine!!).getString("reason"))
        assertEquals(2, launcher.launched.size)
        assertEquals(clock.now(), launcher.launchTimes.last())
    }

    @Test fun stopRequestStopsTheCoreAndKeepsItDown() {
        sup.tick()
        val node = launcher.launched.last()
        stopped = true
        sup.tick()
        assertFalse(node.running)
        assertEquals("stop_requested", JSONObject(node.stopLine!!).getString("reason"))
        repeat(5) { tick() }
        assertEquals(1, launcher.launched.size)
        stopped = false
        sup.tick()
        assertEquals(2, launcher.launched.size)
    }

    @Test fun shutdownSendsLifecycleStopWithADeadline() {
        sup.tick()
        val node = launcher.launched.last()
        sup.shutdown("system_shutdown", 5_000)
        val e = JSONObject(node.stopLine!!)
        assertEquals("system_shutdown", e.getString("reason"))
        assertEquals(clock.now() + 5_000, e.getLong("deadline"))
        assertEquals(1, gone)
    }

    @Test fun powerSaverOnAtLaunchIsTold() {
        val s = KernelSupervisor(clock, provisioner, launcher, env, { stopped }, { shown += it }, { notes += it }, powerSaver = { true })
        s.tick()
        assertEquals("power", JSONObject(launcher.launched.last().events[0]).getString("what"))
    }

    @Test fun sendEventReachesARunningCoreOnly() {
        assertFalse(sup.sendEvent(HostEvents.wakeFired(1)))
        sup.tick()
        assertTrue(sup.sendEvent(HostEvents.wakeFired(1)))
        assertEquals("wake.fired", JSONObject(launcher.launched.last().events.last()).getString("event"))
        crash()
        assertFalse(sup.sendEvent(HostEvents.wakeFired(2)))
    }

    // ---- installing

    @Test fun installsBeforeStartingAndPausesAfterAFailure() {
        provisioner.needs = true
        provisioner.failures = 1
        sup.tick()
        assertEquals(1, provisioner.runs)
        assertEquals(0, launcher.launched.size)
        clock.advance(5_000); sup.tick()
        assertEquals("not re-extracted at once", 1, provisioner.runs)
        assertEquals("the core still starts: the old payload is better than none", 1, launcher.launched.size)
        clock.advance(60_000); sup.tick()
        assertEquals(2, provisioner.runs)
        assertEquals(2, launcher.launched.size)
        assertTrue(shown.contains("正在安装运行环境…"))
    }

    // ---- status text

    @Test fun readyAndStatusSetShapeTheNotification() {
        sup.tick()
        sup.onReady("0.4.0", 1)
        assertEquals("运行中", shown.last())
        sup.onStatus("2 个任务在跑", "running")
        assertEquals("2 个任务在跑", shown.last())
    }
}
