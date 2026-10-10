package ai.ash.kernel

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import ai.ash.link.IHand

/** The remote end of the binding: the hand app's HandService. */
interface HandRemote {
    @Throws(Exception::class)
    fun attach(port: Int, token: String, kernelVersion: String)
}

/** The binding itself (Android: bindService / unbindService). Events come back through [HandConnector]. */
interface HandLink {
    /** Starts binding; false when the hand app is not installed or refuses. */
    fun bind(): Boolean
    fun unbind()
}

/** Runs a task later; the returned function cancels it. */
fun interface Scheduler {
    fun schedule(delayMs: Long, task: () -> Unit): () -> Unit
}

/**
 * Keeps the hand app bound (which keeps its process alive with the kernel's foreground service) and gives it the local
 * connection details: `IHand.attach(port, token, kernelVersion)`. The details come from the core through hands.handoff
 * and are given again every time the binding comes back. The AIDL carries nothing else; all data goes over the WebSocket.
 *
 * A lost binding is rebound after 1, 2, 4 ... 30 seconds; an app that is not installed is tried every 5 minutes.
 */
class HandConnector(
    private val link: HandLink,
    private val scheduler: Scheduler,
    private val kernelVersion: String,
    private val log: (String) -> Unit = {},
    /** How long hands.handoff waits for a binding that is being made. */
    private val connectWaitMs: Long = 3_000,
) : HandsPort {
    private val lock = Object()
    private var remote: HandRemote? = null
    private var bound = false
    private var failures = 0
    private var cancelRebind: (() -> Unit)? = null
    private var details: Pair<Int, String>? = null
    private var deliveredFor: Pair<Int, String>? = null

    /** Begin binding (at service start, so the hand app lives even before the core has anything to hand over). */
    fun start() = synchronized(lock) { bindNow() }

    fun stop() = synchronized(lock) {
        cancelRebind?.invoke(); cancelRebind = null
        if (bound) link.unbind()
        bound = false; remote = null; details = null; deliveredFor = null
    }

    /** The core stopped: its port and token are stale. */
    fun forget() = synchronized(lock) { details = null; deliveredFor = null }

    /** hands.handoff: remember the details, deliver them now if the hand is bound. Returns the packages delivered to. */
    override fun handoff(port: Int, token: String): List<String> {
        synchronized(lock) {
            details = port to token
            deliveredFor = null
            if (remote != null) deliver()
            else {
                // A hand installed since the last try should not wait out the retry timer.
                if (!bound) bindNow()
                if (connectWaitMs > 0) {
                    val until = System.currentTimeMillis() + connectWaitMs
                    while (deliveredFor == null && System.currentTimeMillis() < until) {
                        val left = until - System.currentTimeMillis()
                        if (left > 0) lock.wait(left)
                    }
                }
            }
            return if (deliveredFor == details) listOf(HAND_PACKAGE) else emptyList()
        }
    }

    // ---- callbacks of the binding

    fun onConnected(r: HandRemote) = synchronized(lock) {
        remote = r
        failures = 0
        cancelRebind?.invoke(); cancelRebind = null
        log("hand connected")
        if (details != null) deliver()
        lock.notifyAll()
    }

    /** onServiceDisconnected or onBindingDied: the hand's process went away. Rebind, which also starts it again. */
    fun onLost() = synchronized(lock) {
        remote = null
        deliveredFor = null
        if (bound) { link.unbind(); bound = false }
        log("hand binding lost")
        scheduleRebind(backoffMs(failures++))
    }

    // ---- inside

    private fun bindNow() {
        if (bound) return
        cancelRebind?.invoke(); cancelRebind = null
        val ok = try { link.bind() } catch (e: Exception) { log("bind failed: ${e.javaClass.simpleName}"); false }
        if (ok) bound = true
        else {
            link.unbind() // bindService wants its matching unbind even when it returns false
            scheduleRebind(ABSENT_RETRY_MS)
        }
    }

    private fun scheduleRebind(delayMs: Long) {
        cancelRebind?.invoke()
        cancelRebind = scheduler.schedule(delayMs) { synchronized(lock) { cancelRebind = null; bindNow() } }
    }

    private fun deliver() {
        val d = details ?: return
        val r = remote ?: return
        try {
            r.attach(d.first, d.second, kernelVersion)
            deliveredFor = d
            log("hand attached")
        } catch (e: Exception) {
            // The binder died under us: onLost follows and the details are given again after the rebind.
            log("attach failed: ${e.javaClass.simpleName}")
        }
        lock.notifyAll()
    }

    companion object {
        const val HAND_PACKAGE = "ai.ash.agent"
        const val HAND_SERVICE = "ai.ash.link.HandService"
        const val ABSENT_RETRY_MS = 5 * 60_000L

        /** 1, 2, 4, 8, 16, 30, 30 ... seconds. */
        fun backoffMs(failures: Int): Long = minOf(1_000L shl failures.coerceIn(0, 5), 30_000L)
    }
}

/** The Android side: bindService on the hand app's HandService, BIND_AUTO_CREATE | BIND_IMPORTANT. */
class AndroidHandLink(private val ctx: Context) : HandLink {
    lateinit var connector: HandConnector

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            val hand = IHand.Stub.asInterface(service)
            connector.onConnected(object : HandRemote {
                override fun attach(port: Int, token: String, kernelVersion: String) = hand.attach(port, token, kernelVersion)
            })
        }

        override fun onServiceDisconnected(name: ComponentName) = connector.onLost()
        override fun onBindingDied(name: ComponentName) = connector.onLost()
        override fun onNullBinding(name: ComponentName) = connector.onLost()
    }

    override fun bind(): Boolean {
        val intent = Intent().setComponent(ComponentName(HandConnector.HAND_PACKAGE, HandConnector.HAND_SERVICE))
        return ctx.bindService(intent, connection, Context.BIND_AUTO_CREATE or Context.BIND_IMPORTANT)
    }

    override fun unbind() {
        try { ctx.unbindService(connection) } catch (_: IllegalArgumentException) { /* was not bound */ }
    }
}
