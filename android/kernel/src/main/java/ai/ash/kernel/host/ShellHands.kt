package ai.ash.kernel.host

import ai.ash.kernel.HandsPort
import android.os.Binder
import android.os.Bundle
import android.util.Log
import java.io.File

/**
 * Gives the hand app (ai.ash.agent) the core's local link details, so it connects to the core over the loopback
 * WebSocket, and this host's presence token (a binder with nothing on it, alive while this host is), so the app can show
 * that 「后台也能动手」 is there. In host mode the shell host, not the kernel service, does this: it calls the hand app's
 * door. The app keeps both only in memory, so they are handed over again whenever the app's process is a new one (the
 * owner closed it, the system killed it); a process that is not running is never started for this.
 */
class ShellHands(private val handPackage: String, private val userId: Int) : HandsPort {
    private val presence = Binder()
    @Volatile private var link: Pair<Int, String>? = null
    @Volatile private var deliveredTo = 0

    override fun handoff(port: Int, token: String): List<String> {
        link = port to token
        val pid = pidOf(handPackage)
        return if (deliver(port, token)) { deliveredTo = pid; listOf(handPackage) } else emptyList()
    }

    /** Watches for a new hand process and hands it the details again. */
    fun watch() {
        Thread({
            while (true) {
                try { Thread.sleep(5_000) } catch (e: InterruptedException) { return@Thread }
                val (port, token) = link ?: continue
                val pid = pidOf(handPackage)
                if (pid != 0 && pid != deliveredTo && deliver(port, token)) deliveredTo = pid
            }
        }, "ash-hands-watch").apply { isDaemon = true; start() }
    }

    private fun deliver(port: Int, token: String): Boolean {
        val extras = Bundle().apply { putInt("port", port); putString("token", token); putBinder("host", presence) }
        val ok = runCatching { ProviderClient.call("$handPackage.hostshell", userId, "hand", extras)?.getBoolean("ok") == true }.getOrDefault(false)
        Log.i("ash.kernel.host", "handoff to $handPackage: ${if (ok) "delivered" else "not delivered"}")
        return ok
    }

    /** The pid of the app's main process, or 0 when it is not running (the shell user may read every /proc/<pid>/cmdline). */
    private fun pidOf(name: String): Int {
        for (dir in File("/proc").listFiles() ?: return 0) {
            val pid = dir.name.toIntOrNull() ?: continue
            val cmd = runCatching { File(dir, "cmdline").readBytes() }.getOrNull() ?: continue
            val end = cmd.indexOf(0).let { if (it < 0) cmd.size else it }
            if (String(cmd, 0, end) == name) return pid
        }
        return 0
    }
}
