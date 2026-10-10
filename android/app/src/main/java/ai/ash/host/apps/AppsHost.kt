package ai.ash.host.apps

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * Where the apps shell reaches the core: it forwards the owner's apps routes ([AppsRoutes]) to the core, as the owner,
 * and nothing else. The shell's pages never see the token. Every call blocks: never on the main thread.
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
     * TODO(T11b-2): the apps routes go to the kernel over the link. The old way (the owner's token read from the core's
     * private record, then HTTP to a port on this phone) is gone with the old core, so until then no apps route is answered.
     */
    @Suppress("UNUSED_PARAMETER")
    private fun forward(ctx: Context, method: String, path: String, body: String): JSONObject {
        if (body.length > MAX_BODY) return reply(413, "request too large")
        return reply(503, "ash core is not running")
    }
}
