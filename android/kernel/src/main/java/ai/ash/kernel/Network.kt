package ai.ash.kernel

import org.json.JSONObject

/** An HTTP proxy as the host contract names it (`network.proxy`). */
data class Proxy(val http: String?, val https: String?, val noProxy: String?) {
    fun toJson(): JSONObject = JSONObject().also {
        http?.let { v -> it.put("http", v) }
        https?.let { v -> it.put("https", v) }
        noProxy?.let { v -> it.put("no_proxy", v) }
    }

    companion object {
        const val LOCAL = "127.0.0.1,localhost,::1"

        /** The phone's proxy as `host:port` to the contract's form. */
        fun of(hostPort: String?): Proxy? {
            if (hostPort.isNullOrBlank()) return null
            val url = "http://$hostPort"
            return Proxy(url, url, LOCAL)
        }
    }
}

/** `{ "proxy": null }` or `{ "proxy": { http, https, no_proxy } }`. */
fun networkJson(proxy: Proxy?): JSONObject = JSONObject().put("proxy", proxy?.toJson() ?: JSONObject.NULL)

/** Proxy variables understood by node (NODE_USE_ENV_PROXY), npm, git, curl and pip. */
fun proxyEnv(proxy: Proxy?): Map<String, String> {
    if (proxy == null) return emptyMap()
    val out = LinkedHashMap<String, String>()
    proxy.http?.let { out["HTTP_PROXY"] = it; out["http_proxy"] = it }
    proxy.https?.let { out["HTTPS_PROXY"] = it; out["https_proxy"] = it }
    proxy.noProxy?.let { out["NO_PROXY"] = it; out["no_proxy"] = it }
    return out
}
