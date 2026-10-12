// Adapted from Shizuku (https://github.com/RikkaApps/Shizuku), manager/.../adb/AdbMdns.kt, Apache License 2.0
// (see THIRD_PARTY_NOTICES.md). Changes: a callback instead of LiveData; comments for Ash.
package ai.ash.caps.hostshell.adb

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import java.net.NetworkInterface

/**
 * Finds the port this phone's wireless debugging listens on, as it announces it on the local network: [PAIRING] while the
 * owner has the 「使用配对码配对设备」 dialog open, [CONNECT] while wireless debugging is on. Only this phone's own
 * announcement counts (its address is one of this phone's). Reading an announcement changes nothing on the phone.
 */
class AdbMdns(ctx: Context, private val type: String, private val onPort: (Int) -> Unit) {
    private val nsd = ctx.getSystemService(NsdManager::class.java)
    @Volatile private var running = false

    private val discovery = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(serviceType: String) {}
        override fun onDiscoveryStopped(serviceType: String) {}
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { Log.w(TAG, "discovery failed: $errorCode") }
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
        override fun onServiceLost(info: NsdServiceInfo) {}
        override fun onServiceFound(info: NsdServiceInfo) {
            @Suppress("DEPRECATION")
            runCatching { nsd.resolveService(info, Resolve()) }
        }
    }

    private inner class Resolve : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {}
        override fun onServiceResolved(info: NsdServiceInfo) {
            @Suppress("DEPRECATION")
            val host = info.host?.hostAddress ?: return
            if (running && isThisPhone(host)) onPort(info.port)
        }
    }

    fun start() {
        if (running) return
        running = true
        nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, discovery)
    }

    fun stop() {
        if (!running) return
        running = false
        runCatching { nsd.stopServiceDiscovery(discovery) }
    }

    private fun isThisPhone(host: String): Boolean = runCatching {
        NetworkInterface.getNetworkInterfaces().asSequence().any { nif -> nif.inetAddresses.asSequence().any { it.hostAddress == host } }
    }.getOrDefault(false)

    companion object {
        private const val TAG = "ash.hostshell"
        const val PAIRING = "_adb-tls-pairing._tcp"
        const val CONNECT = "_adb-tls-connect._tcp"
    }
}
