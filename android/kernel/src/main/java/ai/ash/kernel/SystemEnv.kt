package ai.ash.kernel

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import java.util.Locale
import java.util.TimeZone

/** What the host reads from the system: the proxy, DNS, connectivity and what kind of device this is. */
interface EnvSource {
    fun proxy(): Proxy?
    fun online(): Boolean
}

class SystemEnv(private val ctx: Context) : EnvSource {
    /**
     * The phone's HTTP proxy (Wi-Fi proxy setting, or what a proxy app published). VPN-style proxies need nothing
     * (traffic is tunneled below us); this covers the rest, e.g. a network where overseas names only resolve through a proxy.
     */
    override fun proxy(): Proxy? {
        try {
            val cm = ctx.getSystemService(ConnectivityManager::class.java)
            val pi = cm.defaultProxy
            if (pi != null && !pi.host.isNullOrBlank() && pi.port > 0) return Proxy.of("${pi.host}:${pi.port}")
        } catch (_: Exception) {
        }
        val h = System.getProperty("http.proxyHost")
        val port = System.getProperty("http.proxyPort")
        return if (!h.isNullOrBlank() && !port.isNullOrBlank()) Proxy.of("$h:$port") else null
    }

    override fun online(): Boolean = try {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        cm.getNetworkCapabilities(cm.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    } catch (_: Exception) {
        false
    }

    /**
     * DNS servers of the active network (IPv4 first) for the container's resolv.conf: Android has no resolv.conf of
     * its own, and proot's Ubuntu reads only that file. Public resolvers when the network does not say.
     */
    fun dnsServers(): List<String> = orderDns(
        try {
            val cm = ctx.getSystemService(ConnectivityManager::class.java)
            cm.getLinkProperties(cm.activeNetwork)?.dnsServers.orEmpty().mapNotNull { it.hostAddress }
        } catch (_: Exception) {
            emptyList()
        },
    )

    fun platform(): Platform = Platform(
        os = "android",
        osVersion = Build.VERSION.RELEASE ?: "",
        arch = archOf(Build.SUPPORTED_ABIS.firstOrNull()),
        model = Build.MODEL ?: "",
        locale = Locale.getDefault().toLanguageTag(),
        timezone = TimeZone.getDefault().id,
    )

    companion object {
        /** Public resolvers reachable from mainland China, for when the network names none. */
        val FALLBACK_DNS = listOf("223.5.5.5", "119.29.29.29")

        /** Nameservers for the container: IPv4 first (some IPv6 resolvers are link-local), no duplicates. */
        fun orderDns(hosts: List<String>): List<String> =
            hosts.map { it.trim() }.filter { it.isNotEmpty() }.distinct().sortedBy { if (it.contains(':')) 1 else 0 }.ifEmpty { FALLBACK_DNS }

        /** Android ABI names to Node's `process.arch` names. */
        fun archOf(abi: String?): String = when (abi) {
            "arm64-v8a" -> "arm64"
            "armeabi-v7a", "armeabi" -> "arm"
            "x86_64" -> "x64"
            "x86" -> "ia32"
            else -> abi ?: "unknown"
        }
    }
}
