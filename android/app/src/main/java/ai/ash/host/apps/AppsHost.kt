package ai.ash.host.apps

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * Where the apps shell reaches the kernel: it is to forward the owner's apps routes ([AppsRoutes]) as the owner, and nothing
 * else; the shell's pages never see a credential. Every call blocks: never on the main thread. See [forward] for why it
 * answers nothing yet.
 */
object AppsHost {
    private const val TAG = "ash.apps"
    private const val MAX_BODY = 1 shl 20

    internal fun reply(status: Int, error: String): JSONObject =
        JSONObject().put("status", status).put("type", "application/json").put("body", JSONObject().put("error", error).toString())

    /** One request to the core's apps API, e.g. ("GET", "/api/apps", "") or ("POST", "/api/apps/health/call", "{...}"). Answers {status, type, body} (text) or {status, type, base64} (an image); 403 for a path that is not an apps route, 503 when the core is not running. */
    fun request(ctx: Context, method: String, path: String, body: String): JSONObject {
        if (!AppsRoutes.allowed(method, path)) return reply(403, "not an apps route")
        return try { forward(ctx, method, path, body) }
        catch (e: Exception) { Log.w(TAG, "apps request failed: ${e.javaClass.simpleName}"); reply(502, "ash core did not answer") }
    }

    /**
     * Not wired: the specification does not say how the apps shell reaches the kernel now (SPEC-02 §8.2 names the words,
     * `service:apps/apps.list|surface|icon` and `app:<id>/<tool>`, but not how the shell's own process reaches the app's one
     * connection, where an app page's network domains come from now that `apps.surface` no longer returns them, or how a
     * tool result becomes the MCP result the page expects). So every apps route stays unanswered (503) until that is decided.
     */
    private fun forward(ctx: Context, method: String, path: String, body: String): JSONObject {
        if (body.length > MAX_BODY) return reply(413, "request too large")
        return reply(503, "ash core is not running")
    }
}
