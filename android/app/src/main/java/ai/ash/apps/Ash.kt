package ai.ash.apps

import ai.ash.host.apps.AppPins
import ai.ash.host.apps.AppsHost
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/** One of the owner's apps, as Ash lists it. */
data class AppInfo(
    val id: String, val name: String, val version: String, val summary: String,
    val surfaces: List<Pair<String, String>>, val enabled: Boolean, val granted: Boolean,
) {
    val usable get() = enabled && granted

    companion object {
        /** GET /api/apps; entries with an id the shell cannot give an origin to are left out. */
        fun list(json: String): List<AppInfo> {
            val a = JSONArray(json)
            return (0 until a.length()).mapNotNull { i ->
                val o = a.optJSONObject(i) ?: return@mapNotNull null
                val id = o.optString("id").takeIf { AppIds.valid(it) } ?: return@mapNotNull null
                val s = o.optJSONArray("surfaces") ?: JSONArray()
                val surfaces = (0 until s.length()).mapNotNull { j ->
                    val so = s.optJSONObject(j) ?: return@mapNotNull null
                    val sid = so.optString("id").takeIf { AppIds.validSurface(it) } ?: return@mapNotNull null
                    sid to so.optString("title", sid).ifBlank { sid }.take(40)
                }
                AppInfo(id, o.optString("name", id).ifBlank { id }.take(60), o.optString("version").take(40), o.optString("summary").take(300),
                    surfaces, o.optBoolean("enabled", true), o.optBoolean("granted", false))
            }
        }
    }
}

/** Ash's core could not be reached (not running) or refused. */
class AshUnavailable(message: String) : Exception(message)

/**
 * The shell's only way out: Ash's apps host ([AppsHost]), which forwards the owner's apps routes to the core. Every call
 * here blocks: never on the main thread.
 */
object Ash {
    private const val TAG = "ash.apps"

    fun installed(ctx: Context): Boolean = true

    class Reply(val status: Int, val type: String, val body: String, val bytes: ByteArray?) {
        val ok get() = status in 200..299
        /** The core's error text, if it gave one. */
        fun error(): String = runCatching { JSONObject(body).let { it.optString("message").ifBlank { it.optString("error") } } }.getOrNull()?.takeIf { it.isNotBlank() }?.take(200)
            ?: "HTTP $status"
    }

    fun request(ctx: Context, method: String, path: String, body: String = ""): Reply {
        val o = try { AppsHost.request(ctx.applicationContext, method, path, body) }
        catch (e: Exception) { Log.w(TAG, "request to the core failed", e); throw AshUnavailable("连不上 Ash：打开 Ash 后再试") }
        val reply = Reply(o.optInt("status", 502), o.optString("type"), o.optString("body"),
            o.optString("base64").takeIf { it.isNotEmpty() }?.let { runCatching { Base64.decode(it, Base64.DEFAULT) }.getOrNull() })
        if (reply.status == 503) throw AshUnavailable("Ash 没在运行：打开 Ash 后再试")
        return reply
    }

    // The apps API (Ash's core, owner only).

    fun apps(ctx: Context): List<AppInfo> {
        val r = request(ctx, "GET", "/api/apps")
        if (r.status == 404) throw AshUnavailable("这个版本的 Ash 还不支持应用：请更新 Ash")
        if (!r.ok) throw AshUnavailable("Ash 没给出应用列表（${r.error()}）")
        return runCatching { AppInfo.list(r.body) }.getOrElse { throw AshUnavailable("应用列表看不懂") }
    }

    fun icon(ctx: Context, id: String): Bitmap? = runCatching {
        val r = request(ctx, "GET", "/api/apps/$id/icon")
        val bytes = r.bytes?.takeIf { r.ok } ?: return null
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }.getOrNull()

    /** An app's page: its HTML and the network domains it declared. */
    fun surface(ctx: Context, id: String, surface: String): Pair<String, Csp> {
        val r = request(ctx, "GET", "/api/apps/$id/surfaces/$surface")
        if (!r.ok) throw AshUnavailable("打不开这一页（${r.error()}）")
        val o = runCatching { JSONObject(r.body) }.getOrNull() ?: throw AshUnavailable("这一页看不懂")
        val html = o.optString("html").takeIf { it.isNotBlank() } ?: throw AshUnavailable("这一页是空的")
        return html to Csp.fromJson(o.optJSONObject("csp"))
    }

    /** The backend the MCP Apps host uses: always the one app's own routes. */
    fun backend(ctx: Context) = object : AppsBackend {
        override fun callTool(app: String, tool: String, arguments: JSONObject): JSONObject {
            val r = try { request(ctx, "POST", "/api/apps/$app/call", JSONObject().put("tool", tool).put("arguments", arguments).toString()) }
            catch (e: AshUnavailable) { throw AppsError(e.message ?: "Ash unavailable") }
            if (!r.ok) throw AppsError(r.error())
            return runCatching { JSONObject(r.body) }.getOrElse { throw AppsError("Invalid tool result") }
        }
        override fun sendMessage(app: String, text: String) {
            val r = try { request(ctx, "POST", "/api/apps/$app/message", JSONObject().put("text", text).toString()) }
            catch (e: AshUnavailable) { throw AppsError(e.message ?: "Ash unavailable") }
            if (!r.ok) throw AppsError(r.error())
        }
    }

    /**
     * 「添加到桌面」 as a shortcut of the app itself (see [AppPins]): PIN_ASKED, PIN_UNSUPPORTED or PIN_FAILED. 0 never
     * comes back now; Pin still reads it as "Ash cannot do it".
     */
    fun requestPin(ctx: Context, id: String, name: String, icon: Bitmap?, result: android.content.IntentSender): Int =
        AppPins.request(ctx.applicationContext, id, name, icon?.takeIf { it.width in 1..1024 && it.height in 1..1024 }, result)

    /** Whether the app's shortcut is on the home screen (false when it cannot be told). */
    fun pinned(ctx: Context, id: String): Boolean = AppPins.pinned(ctx.applicationContext, id)

    /** Ash's own screen: where the owner approves an app. */
    fun open(ctx: Context) {
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return
        ctx.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
