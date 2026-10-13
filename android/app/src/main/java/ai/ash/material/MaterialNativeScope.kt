package ai.ash.material

import org.json.JSONObject
import java.io.ByteArrayOutputStream

/** Captured from authenticated Core control frames, never a WebMessage body. */
internal data class MaterialNativeScope(val pageEpoch: Long, val screenId: String, val screenToken: String,
    val authScope: String, val credentialGeneration: String)

/** Observe the existing native Core SSE stream before forwarding it to the page.
 * Oversized business frames are discarded; only bounded, cursor-free control frames
 * can change the native screen binding. auth_scope is an invalidation hint, not authority.
 */
internal class MaterialNativeScreenObserver(private val registration: (JSONObject) -> Unit,
    private val scopeChanged: (String) -> Unit) {
    private val frame = ByteArrayOutputStream()
    private var dropping = false
    private var previousLf = false
    fun accept(bytes: ByteArray) {
        for (byte in bytes) {
            if (byte == '\r'.code.toByte()) continue
            if (!dropping) {
                if (frame.size() >= 64 * 1024) { dropping = true; frame.reset() } else frame.write(byte.toInt())
            }
            val lf = byte == '\n'.code.toByte()
            if (lf && previousLf) {
                if (!dropping) runCatching { observe(frame.toString("UTF-8")) }
                frame.reset(); dropping = false
            }
            previousLf = lf
        }
    }
    private fun observe(value: String) {
        val lines = value.lines()
        if (lines.any { it.startsWith("id:") }) return
        val events = lines.filter { it.startsWith("event:") }.map { it.substringAfter(':').trim() }
        val data = lines.filter { it.startsWith("data:") }.joinToString("\n") { it.substringAfter(':').trimStart() }
        val body = JSONObject(data)
        when (events.singleOrNull()) {
            "screen.registered" -> {
                require(body.keys().asSequence().toSet() == setOf("screen", "token", "label", "auth_scope", "local_management"))
                require(body.get("local_management") == true)
                require(Regex("screen:[A-Za-z0-9_-]{1,128}").matches(body.getString("screen")))
                require(Regex("[A-Za-z0-9_-]{32,128}").matches(body.getString("token")))
                require(Regex("v1_[A-Za-z0-9_-]{43}").matches(body.getString("auth_scope")))
                require(body.getString("label").length in 1..80)
                registration(body)
            }
            "auth.scope" -> {
                require(body.keys().asSequence().toSet() == setOf("auth_scope"))
                val scope = body.getString("auth_scope")
                require(Regex("v1_[A-Za-z0-9_-]{43}").matches(scope)); scopeChanged(scope)
            }
        }
    }
}

/** The broad UI proxy carries host proof, so native ingress is excluded before
 * transport. Canonicalize decoded dot segments and compare case-insensitively;
 * Core's actual route is narrower and does not accept these alternate spellings.
 */
internal fun materialNativeIngressPath(path: String): Boolean = runCatching {
    val decoded = java.net.URI(path).path ?: return@runCatching false
    val segments = mutableListOf<String>()
    for (segment in decoded.split('/')) when (segment) {
        "", "." -> Unit
        ".." -> if (segments.isNotEmpty()) segments.removeAt(segments.lastIndex)
        else -> segments.add(segment)
    }
    val canonical = "/" + segments.joinToString("/").lowercase(java.util.Locale.ROOT)
    canonical == "/api/collaboration/material/native" || canonical.startsWith("/api/collaboration/material/native/")
}.getOrDefault(false)
