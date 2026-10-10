package ai.ash.kernel

/** Time and waiting, so the supervisor can be driven by a fake clock. */
interface Clock {
    /** Monotonic milliseconds for measuring intervals (start timeout, heartbeat, backoff): not the wall clock, so changing the system time cannot fake a timeout. */
    fun now(): Long

    /** Wall-clock epoch milliseconds, for a time the core must also understand (the `lifecycle.stop` deadline). */
    fun wallNow(): Long = now()

    /** Sleeps up to [ms]; returns early when [wake] is called. */
    fun sleep(ms: Long)
    fun wake()
}

class SystemClock : Clock {
    private val lock = Object()
    private var signaled = false

    override fun now(): Long = android.os.SystemClock.elapsedRealtime()

    override fun wallNow(): Long = System.currentTimeMillis()

    override fun sleep(ms: Long) = synchronized(lock) {
        if (!signaled) try { lock.wait(ms) } catch (_: InterruptedException) {}
        signaled = false
    }

    override fun wake() = synchronized(lock) { signaled = true; lock.notifyAll() }
}

/** Installs what the APK carries (payload, then container) before the core may start. */
interface Provisioner {
    fun needsWork(): Boolean

    /** Blocking; reports human-readable progress for the notification. */
    fun run(progress: (String) -> Unit)
}

/** Starts one core process: writes host.json, makes the token and the seal key, spawns. */
interface NodeLauncher {
    fun launch(): NodeHandle
}

/** Backoff of crash restarts: 5 s, doubling to 5 min; a run of 10 minutes or more counts as stable and clears it. */
object RestartBackoff {
    const val FIRST_MS = 5_000L
    const val MAX_MS = 300_000L
    const val STABLE_MS = 10 * 60_000L

    fun delayMs(failures: Int): Long = minOf(FIRST_MS shl (failures - 1).coerceIn(0, 6), MAX_MS)
}

/** Liveness of a core that said it is ready (a core that never does is caught by the start timeout): any call to the host interface is a heartbeat; 180 s of silence is a hang. */
class HeartbeatWatch(private val timeoutMs: Long = TIMEOUT_MS) {
    private var readyAt = -1L
    private var last = -1L

    @Synchronized fun reset() { readyAt = -1L; last = -1L }
    @Synchronized fun ready(now: Long) { readyAt = now; last = now }
    @Synchronized fun beat(now: Long) { if (readyAt >= 0) last = now }

    @Synchronized fun isReady(): Boolean = readyAt >= 0

    /** Only a core that has said `lifecycle.ready` can be late: booting is not watched. */
    @Synchronized fun expired(now: Long): Boolean = readyAt >= 0 && now - last > timeoutMs

    companion object { const val TIMEOUT_MS = 180_000L }
}

/** The state shown in the notification and kept for diagnostics. */
enum class KernelState { STARTING, INSTALLING, RUNNING, RESTARTING, STOPPED, ERROR }

/**
 * Keeps exactly one core process running:
 *  - installs what is missing, then starts the core; a core that exits is restarted with [RestartBackoff];
 *  - a core that has said it is ready and then goes 180 s without a call to the host interface is killed and restarted;
 *  - a changed proxy or connectivity is told to the core as `env.changed`; the core is NOT restarted for it.
 * [tick] does one pass and never blocks for long except while installing or stopping; [run] calls it until [shutdown].
 */
class KernelSupervisor(
    private val clock: Clock,
    private val provisioner: Provisioner,
    private val launcher: NodeLauncher,
    private val env: EnvSource,
    private val stopped: () -> Boolean,
    /** Called with the notification text. */
    private val show: (String) -> Unit,
    private val note: (String) -> Unit,
    /** The core went away: whatever it handed out (the hands' port and token) is stale. */
    private val onNodeGone: () -> Unit = {},
    private val powerSaver: () -> Boolean = { false },
    private val stopGraceMs: Long = 10_000,
) : HostCallbacks {
    private val watch = HeartbeatWatch()

    @Volatile private var running = true
    @Volatile private var restartRequested = false
    @Volatile var state: KernelState = KernelState.STOPPED
        private set

    @Volatile private var node: NodeHandle? = null
    private var startedAt = 0L
    private var nextStartAt = 0L
    private var failures = 0
    private var everStarted = false
    @Volatile private var statusText: String? = null
    private var launchedProxy: Proxy? = null
    private var launchedOnline = false
    private var provisionRetryAt = 0L
    private var lastError: String? = null

    fun run() {
        while (running) {
            tick()
            clock.sleep(TICK_MS)
        }
    }

    fun shutdown(reason: String = "service_stopped", graceMs: Long = stopGraceMs) {
        running = false
        clock.wake()
        stopNode(reason, graceMs)
    }

    /** Wakes the loop (a start/stop/restart request just arrived). */
    fun poke() = clock.wake()

    fun requestRestart(reason: String) {
        note("restart requested: $reason")
        restartRequested = true
        clock.wake()
    }

    /** Sends a host event line to the core, if one is running. */
    fun sendEvent(line: String): Boolean = node?.takeIf { it.isRunning() }?.writeEvent(line) ?: false

    @Synchronized
    fun tick() {
        try {
            if (clock.now() >= provisionRetryAt && provisioner.needsWork()) {
                stopNode("install")
                state = KernelState.INSTALLING
                show(KernelText.INSTALLING)
                try {
                    provisioner.run { show(it) }
                } catch (e: Exception) {
                    // Out of space, a bad archive ...: do not extract hundreds of MB again every tick.
                    provisionRetryAt = clock.now() + PROVISION_RETRY_MS
                    throw e
                }
            }
            val n = node
            if (stopped()) {
                if (n != null) { note("stopping ash core (stop requested)"); stopNode("stop_requested") }
                state = KernelState.STOPPED
                show(KernelText.STOPPED)
                return
            }
            if (n != null && !n.isRunning()) { onExit(); return tickStart() }
            if (n == null) {
                // A restart asked for while the core is down (even inside a crash backoff) starts it now.
                if (restartRequested) { failures = 0; nextStartAt = 0 }
                return tickStart()
            }
            // running
            if (restartRequested) {
                restartRequested = false
                state = KernelState.RESTARTING
                show(KernelText.RESTARTING)
                stopNode("restart")
                failures = 0
                nextStartAt = 0
                return tickStart()
            }
            if (!watch.isReady() && clock.now() - startedAt > START_TIMEOUT_MS) {
                note("ash core ${pidText(n)} did not say lifecycle.ready within ${START_TIMEOUT_MS / 1000} s; restarting it")
                n.stop(null, 0)
                return
            }
            if (watch.expired(clock.now())) {
                note("ash core ${pidText(n)} sent no heartbeat for ${HeartbeatWatch.TIMEOUT_MS / 1000} s; restarting it")
                n.stop(null, 0)
                return
            }
            checkEnv(n)
        } catch (e: Throwable) {
            state = KernelState.ERROR
            note("supervisor: ${e.javaClass.simpleName}: ${e.message}")
            lastError = e.message ?: e.javaClass.simpleName
            show(KernelText.error(lastError))
        }
    }

    private fun pidText(n: NodeHandle) = (n as? NodeProcess)?.let { "(pid ${it.pid})" } ?: ""

    private fun onExit() {
        val ran = clock.now() - startedAt
        note("ash core exited after ${ran / 1000} s")
        node = null
        watch.reset()
        onNodeGone()
        if (restartRequested) { restartRequested = false; failures = 0; nextStartAt = 0; return }
        if (ran >= RestartBackoff.STABLE_MS) failures = 0
        failures++
        nextStartAt = clock.now() + RestartBackoff.delayMs(failures)
    }

    private fun tickStart() {
        if (node != null) return
        if (clock.now() < nextStartAt) {
            state = KernelState.STARTING
            show(lastError?.let { KernelText.error(it) } ?: if (failures > 2) KernelText.RETRYING else KernelText.RESTARTING)
            return
        }
        state = KernelState.STARTING
        show(KernelText.STARTING)
        restartRequested = false
        if (everStarted) note(if (failures > 0) "ash core is down; restarting (attempt ${failures + 1})" else "ash core is down; starting it")
        startedAt = clock.now()
        watch.reset()
        statusText = null
        try {
            val n = launcher.launch()
            everStarted = true
            lastError = null
            node = n
            launchedProxy = env.proxy()
            launchedOnline = env.online()
            if (powerSaver()) n.writeEvent(HostEvents.powerChanged(true))
        } catch (e: Throwable) {
            // Could not even start (no seal key, no node binary ...): the same backoff as a crash.
            failures++
            nextStartAt = clock.now() + RestartBackoff.delayMs(failures)
            throw e
        }
    }

    private fun checkEnv(n: NodeHandle) {
        val proxy = env.proxy()
        val online = env.online()
        if (proxy == launchedProxy && online == launchedOnline) return
        launchedProxy = proxy
        launchedOnline = online
        note("network changed (proxy ${if (proxy == null) "none" else "set"}, ${if (online) "online" else "offline"}); telling the core")
        n.writeEvent(HostEvents.networkChanged(proxy, online))
    }

    /** lifecycle.stop with a deadline, wait for a clean exit, then force. */
    @Synchronized
    fun stopNode(reason: String, graceMs: Long = stopGraceMs) {
        val n = node ?: return
        val line = HostEvents.lifecycleStop(clock.wallNow() + graceMs, reason)
        n.stop(line, graceMs)
        node = null
        watch.reset()
        onNodeGone()
    }

    // ---- HostCallbacks: what the core says through the host interface

    override fun onActivity() = watch.beat(clock.now())

    override fun onReady(version: String, linkPort: Int) {
        watch.ready(clock.now())
        state = KernelState.RUNNING
        note("ash core $version is ready")
        show(statusText ?: KernelText.RUNNING)
    }

    override fun onRestart(reason: String) = requestRestart("asked by the core: $reason")

    override fun onStatus(text: String, state: String) {
        statusText = KernelText.fromCore(text, state)
        if (this.state == KernelState.RUNNING || this.state == KernelState.STARTING) show(statusText ?: KernelText.RUNNING)
    }

    private companion object {
        const val TICK_MS = 5_000L
        const val PROVISION_RETRY_MS = 60_000L

        /** A core that has not said lifecycle.ready this long after its process started is stuck in startup. */
        const val START_TIMEOUT_MS = 5 * 60_000L
    }
}
