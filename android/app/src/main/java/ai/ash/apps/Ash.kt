package ai.ash.apps

import ai.ash.host.apps.AppsBridgeService
import ai.ash.ui.HomeActivity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.DeadObjectException
import android.os.IBinder
import android.os.RemoteException
import android.os.SystemClock
import android.os.TransactionTooLargeException
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
        /** `apps` of the result of `service:apps/apps.list`; entries with an id the shell cannot give an origin to are left out. */
        fun list(a: JSONArray): List<AppInfo> =
            (0 until a.length()).mapNotNull { i ->
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

/** An app's page, from `service:apps/apps.surface`: its HTML and the network domains it declared (its `csp`). */
class Surface(val html: String, val csp: Csp) {
    companion object {
        /** The `data` of the reply; a page without `csp` gets none, which is the strictest. Null when there is no HTML. */
        fun parse(data: JSONObject): Surface? = data.optString("html").takeIf { it.isNotBlank() }?.let { Surface(it, Csp.fromJson(data.optJSONObject("csp"))) }
    }
}

/** Ash could not be reached, or refused; the message is for the owner. */
class AshUnavailable(message: String) : Exception(message)

/**
 * The shell's only way out: the bridge to Ash (`IAppsBridge`, bound lazily; see [AppsBridgeService]), through which it asks for
 * the owner's apps and, for the page it belongs to, calls the app's tools. [app] is that page's app (null: the list screen).
 * Every call blocks: never on the main thread. [close] when the screen goes.
 */
class Ash(ctx: Context, private val app: String?) {
    private val ctx = ctx.applicationContext
    private val lock = Object()
    private var bridge: IAppsBridge? = null
    private var bound = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) { synchronized(lock) { bridge = IAppsBridge.Stub.asInterface(service); lock.notifyAll() } }
        override fun onServiceDisconnected(name: ComponentName) { synchronized(lock) { bridge = null } }
        override fun onBindingDied(name: ComponentName) = reset()
        override fun onNullBinding(name: ComponentName) = reset()
    }

    private fun reset() {
        synchronized(lock) {
            bridge = null
            if (bound) { bound = false; runCatching { ctx.unbindService(connection) } }
            lock.notifyAll()
        }
    }

    fun close() = reset()

    private fun connect(): IAppsBridge? {
        synchronized(lock) {
            if (!bound) bound = ctx.bindService(AppsBridgeService.intent(ctx, app), connection, Context.BIND_AUTO_CREATE)
            if (!bound) return null
            val deadline = SystemClock.elapsedRealtime() + CONNECT_MS
            while (bridge == null && bound) {
                val left = deadline - SystemClock.elapsedRealtime()
                if (left <= 0) return null
                lock.wait(left)
            }
            return bridge
        }
    }

    /** One word to one member, as the owner: the `Reply` ([Replies]). Never throws; Ash being out of reach is an `offline` error. */
    fun call(to: String, word: String, body: JSONObject): JSONObject {
        repeat(2) {
            val b = connect() ?: return Replies.error("offline", OFFLINE)
            try {
                return JSONObject(b.call(to, word, body.toString()))
            } catch (_: DeadObjectException) {
                reset()
            } catch (_: TransactionTooLargeException) {
                return Replies.error("too_large", "太大了，传不过来")
            } catch (e: RemoteException) {
                Log.w(TAG, "the bridge failed: ${e.javaClass.simpleName}")
                return Replies.error("failed", "Ash 没能传回结果")
            } catch (e: Exception) {
                Log.w(TAG, "the bridge answered nonsense: ${e.javaClass.simpleName}")
                return Replies.error("internal", "Ash 的回答看不懂")
            }
        }
        return Replies.error("offline", OFFLINE)
    }

    private fun data(reply: JSONObject, what: String): JSONObject {
        if (!reply.optBoolean("ok")) throw AshUnavailable("$what（${Replies.errorText(reply).take(200)}）")
        return Replies.data(reply) ?: throw AshUnavailable("$what（Ash 没给出内容）")
    }

    // `service:apps` (owner).

    fun apps(): List<AppInfo> {
        val d = data(call("service:apps", "apps.list", JSONObject()), "Ash 没给出应用列表")
        return AppInfo.list(d.optJSONArray("apps") ?: throw AshUnavailable("应用列表看不懂"))
    }

    fun icon(id: String): Bitmap? = runCatching {
        val bytes = Base64.decode(Replies.data(call("service:apps", "apps.icon", JSONObject().put("id", id)))?.optString("data") ?: return null, Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }.getOrNull()

    fun surface(id: String, surface: String): Surface {
        val d = data(call("service:apps", "apps.surface", JSONObject().put("id", id).put("surface", surface)), "打不开这一页")
        return Surface.parse(d) ?: throw AshUnavailable("这一页是空的")
    }

    /** What the MCP Apps host uses for the page's tool calls: always the one app's own tools. */
    fun backend() = object : AppsBackend {
        override fun callTool(app: String, tool: String, arguments: JSONObject): JSONObject =
            Replies.toolResult(call("app:$app", tool, arguments))
    }

    companion object {
        private const val TAG = "ash.apps"
        private const val CONNECT_MS = 10_000L
        private const val OFFLINE = "连不上 Ash：打开 Ash 后再试"

        /** Ash's own screen: where the owner approves an app. */
        fun open(ctx: Context) {
            ctx.startActivity(Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
}
