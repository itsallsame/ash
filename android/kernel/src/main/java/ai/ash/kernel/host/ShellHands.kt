package ai.ash.kernel.host

import ai.ash.kernel.HandsPort
import android.os.Bundle
import android.util.Log

/**
 * Gives the hand app (ai.ash.agent) the core's local link details, so it connects to the core over the loopback
 * WebSocket. In host mode the shell host, not the kernel service, does this: it calls the hand app's door with the
 * port and token. The AIDL/bindService path the kernel service uses is not available to a shell process.
 */
class ShellHands(private val handPackage: String, private val userId: Int) : HandsPort {
    override fun handoff(port: Int, token: String): List<String> {
        val extras = Bundle().apply { putInt("port", port); putString("token", token) }
        val reply = ProviderClient.call("$handPackage.hostshell", userId, "hand", extras)
        val ok = reply?.getBoolean("ok") == true
        Log.i("ash.kernel.host", "handoff to $handPackage: ${if (ok) "delivered" else "not delivered"}")
        return if (ok) listOf(handPackage) else emptyList()
    }
}
