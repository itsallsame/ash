package ai.ash.kernel

import org.json.JSONException
import org.json.JSONObject
import java.security.MessageDigest

/** Answer to one host-interface request. */
data class Reply(val status: Int, val body: JSONObject)

/** What the supervisor hears from the core through the host interface. */
interface HostCallbacks {
    /** Any authenticated call: the core is alive. */
    fun onActivity()
    fun onReady(version: String, linkPort: Int)
    fun onRestart(reason: String)
    fun onStatus(text: String, state: String)
}

/** The local hands (apps on this phone) the link details are handed to. */
interface HandsPort {
    /** Package names the link details were delivered to. */
    fun handoff(port: Int, token: String): List<String>
}

/**
 * The host interface of `ash-host/1` (SPEC-07 section 3), independent of the transport: `POST /v1/<method>` with
 * `Authorization: Bearer <host token>` and a JSON body. Methods of capabilities that are not declared do not exist.
 */
class HostApi(
    /** Capability groups this host declares (host.json `capabilities`). */
    val capabilities: List<String>,
    private val identity: Identity,
    private val wake: WakeManager,
    private val power: PowerPort,
    private val hands: HandsPort,
    private val callbacks: HostCallbacks,
    private val log: (String) -> Unit = {},
    /** The phone actions (vscreen / input / apps). Non-null when any of those groups is declared. */
    private val phone: PhonePort? = null,
) {
    /** The token of the current core run; null while none runs (every call is refused). */
    @Volatile var token: String? = null

    fun handle(httpMethod: String, path: String, authorization: String?, body: ByteArray): Reply {
        val expected = token
        val given = authorization?.takeIf { it.startsWith("Bearer ") }?.substring(7)?.trim()
        if (expected == null || given == null || !MessageDigest.isEqual(given.toByteArray(), expected.toByteArray())) {
            return error(401, "unauthorized", "bad token")
        }
        callbacks.onActivity()
        val method = path.substringBefore('?').removePrefix("/v1/").takeIf { path.startsWith("/v1/") }
        val group = method?.let { METHOD_CAPABILITY[it] }
        if (httpMethod != "POST" || method == null || group == null || group !in capabilities) {
            return error(404, "not_found", "no ${method ?: path}")
        }
        val json = try {
            if (body.isEmpty()) JSONObject() else JSONObject(String(body, Charsets.UTF_8))
        } catch (_: JSONException) {
            return error(400, "bad_request", "bad json")
        }
        return try {
            ok(call(method, json))
        } catch (e: BadRequest) {
            error(400, "bad_request", e.message ?: "bad request")
        } catch (e: PhoneBadRequest) {
            error(400, "bad_request", e.message ?: "bad request")
        } catch (e: PhoneUnavailable) {
            error(503, "unavailable", e.message ?: "not available")
        } catch (e: PhoneFailed) {
            error(500, "failed", e.message ?: "failed")
        } catch (e: Exception) {
            log("host call $method failed: ${e.javaClass.simpleName}")
            error(500, "failed", e.javaClass.simpleName)
        }
    }

    private fun call(method: String, b: JSONObject): JSONObject = when (method) {
        "identity.key" -> {
            val spki = identity.publicKey()
            JSONObject().put("id", Codec.keyId(spki)).put("public_key", Codec.b64u(spki))
        }
        "identity.sign" -> {
            val data = try { Codec.unb64u(b.str("data")) } catch (_: IllegalArgumentException) { throw BadRequest("data is not base64url") }
            if (data.size > MAX_SIGN_BYTES) throw BadRequest("data too large")
            JSONObject().put("sig", Codec.b64u(identity.sign(data)))
        }
        "lifecycle.ready" -> {
            callbacks.onReady(b.str("version"), b.int("link_port", 1, 65535))
            JSONObject()
        }
        "lifecycle.restart" -> {
            callbacks.onRestart(b.optString("reason").take(200))
            JSONObject()
        }
        "status.set" -> {
            val state = b.str("state", allowEmpty = false)
            if (state !in STATES) throw BadRequest("state must be one of ${STATES.joinToString("|")}")
            callbacks.onStatus(b.optString("text").take(200), state)
            JSONObject()
        }
        "wake.at" -> {
            wake.at(b.long("at", 1))
            JSONObject()
        }
        "wake.clear" -> {
            wake.clear()
            JSONObject()
        }
        "power.hold" -> {
            val ms = b.long("ms", 1).coerceAtMost(MAX_HOLD_MS)
            power.hold(ms, b.optString("reason").take(100))
            JSONObject()
        }
        "power.release" -> {
            power.release()
            JSONObject()
        }
        "hands.handoff" -> {
            val delivered = hands.handoff(b.int("port", 1, 65535), b.str("token"))
            JSONObject().put("delivered", org.json.JSONArray(delivered))
        }
        else -> {
            val port = phone ?: throw BadRequest("unsupported $method")
            // What went wrong on the phone (am start refused, the virtual screen gone) is the caller's to read.
            try { port.call(method, b) } catch (e: IllegalStateException) { throw PhoneFailed(e.message ?: e.javaClass.simpleName) }
        }
    }

    private class BadRequest(message: String) : Exception(message)

    private fun JSONObject.str(key: String, allowEmpty: Boolean = false): String {
        val v = opt(key)
        if (v !is String || (!allowEmpty && v.isEmpty())) throw BadRequest("$key must be a non-empty string")
        return v
    }

    private fun JSONObject.long(key: String, min: Long): Long {
        val v = opt(key)
        if (v !is Number || v.toDouble() != Math.floor(v.toDouble()) || v.toLong() < min) throw BadRequest("$key must be an integer >= $min")
        return v.toLong()
    }

    private fun JSONObject.int(key: String, min: Int, max: Int): Int {
        val v = long(key, min.toLong())
        if (v > max) throw BadRequest("$key must be at most $max")
        return v.toInt()
    }

    private fun ok(result: JSONObject) = Reply(200, JSONObject().put("ok", true).put("result", result))

    private fun error(status: Int, code: String, message: String) =
        Reply(status, JSONObject().put("ok", false).put("error", JSONObject().put("code", code).put("message", message)))

    companion object {
        /** What this host declares: update.install is not implemented yet, so `update` is not listed. */
        val CAPABILITIES = listOf("identity", "lifecycle", "status", "wake", "power", "hands")

        private val METHOD_CAPABILITY = mapOf(
            "identity.key" to "identity", "identity.sign" to "identity",
            "lifecycle.ready" to "lifecycle", "lifecycle.restart" to "lifecycle",
            "status.set" to "status",
            "wake.at" to "wake", "wake.clear" to "wake",
            "power.hold" to "power", "power.release" to "power",
            "hands.handoff" to "hands",
            "update.install" to "update",
            "vscreen.create" to "vscreen", "vscreen.status" to "vscreen", "vscreen.launch" to "vscreen",
            "vscreen.see" to "vscreen", "vscreen.tap" to "vscreen", "vscreen.swipe" to "vscreen",
            "vscreen.key" to "vscreen", "vscreen.type" to "vscreen", "vscreen.close" to "vscreen",
            "input.key" to "input",
            "apps.open" to "apps",
        )
        private val STATES = listOf("starting", "running", "degraded", "stopping")
        private const val MAX_HOLD_MS = 600_000L
        private const val MAX_SIGN_BYTES = 64 * 1024
    }
}
