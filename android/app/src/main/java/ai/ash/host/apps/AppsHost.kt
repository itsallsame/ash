package ai.ash.host.apps

import ai.ash.BuildConfig
import ai.ash.host.Paths
import ai.ash.ui.transport.ownerBearerFromPrivateUiUrl
import android.content.Context
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

/**
 * Where the apps shell reaches the core: it forwards the owner's apps routes ([AppsRoutes]) to the core, as the owner,
 * and nothing else. The shell's pages never see the token. Every call blocks: never on the main thread.
 */
object AppsHost {
    private const val TAG = "ash.apps"
    private const val MAX_BODY = 1 shl 20
    private const val MAX_REPLY = 16 shl 20

    internal fun reply(status: Int, error: String): JSONObject =
        JSONObject().put("status", status).put("type", "application/json").put("body", JSONObject().put("error", error).toString())

    /** One request to the core's apps API, e.g. ("GET", "/api/apps", "") or ("POST", "/api/apps/health/call", "{...}"). Answers {status, type, body} (text) or {status, type, base64} (an image); 403 for a path that is not an apps route, 503 when the core is not running. */
    fun request(ctx: Context, method: String, path: String, body: String): JSONObject {
        if (!AppsRoutes.allowed(method, path)) return reply(403, "not an apps route")
        return try { forward(ctx, method, path, body) }
        catch (e: Exception) { Log.w(TAG, "apps request failed: ${e.javaClass.simpleName}"); reply(502, "ash core did not answer") }
    }

    private fun forward(ctx: Context, method: String, path: String, body: String): JSONObject {
        if (body.length > MAX_BODY) return reply(413, "request too large")
        val record = Paths(ctx).uiUrl
        if (!record.exists()) return reply(503, "ash core is not running")
        val token = ownerBearerFromPrivateUiUrl(record.readText().trim(), BuildConfig.CORE_PORT)
        val c = URL("http://127.0.0.1:${BuildConfig.CORE_PORT}$path").openConnection(Proxy.NO_PROXY) as HttpURLConnection
        try {
            c.instanceFollowRedirects = false
            c.requestMethod = method
            c.connectTimeout = 3_000
            c.readTimeout = if (method == "POST") 5 * 60_000 else 15_000
            c.setRequestProperty("authorization", "Bearer $token")
            if (method == "POST") {
                val bytes = body.toByteArray(Charsets.UTF_8)
                c.doOutput = true
                c.setRequestProperty("content-type", "application/json")
                c.setFixedLengthStreamingMode(bytes.size)
                c.outputStream.use { it.write(bytes) }
            }
            val status = try { c.responseCode } catch (e: java.net.ConnectException) { return reply(503, "ash core is not running") }
            if (status in 300..399) return reply(502, "ash core redirected")
            val type = (c.contentType ?: "").take(128)
            val out = ByteArrayOutputStream()
            ((if (status < 400) c.inputStream else c.errorStream))?.use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    if (out.size() + n > MAX_REPLY) return reply(502, "reply too large")
                    out.write(buf, 0, n)
                }
            }
            val bytes = out.toByteArray()
            val result = JSONObject().put("status", status).put("type", type)
            if (AppsRoutes.textual(type)) {
                val text = bytes.toString(Charsets.UTF_8)
                // The owner's credential never leaves Ash, even if a reply carried it.
                if (text.contains(token)) return reply(502, "credential in core reply")
                result.put("body", text)
            } else result.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            return result
        } finally { c.disconnect() }
    }

}
