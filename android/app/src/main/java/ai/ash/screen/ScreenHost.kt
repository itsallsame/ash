package ai.ash.screen

import ai.ash.caps.CapResult
import ai.ash.host.screen.ScreenBridge
import ai.ash.caps.screen.A11yService
import ai.ash.screen.island.NativeIsland
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import ai.ash.caps.screen.KeepAliveSwitches
import ai.ash.caps.screen.ScreenCapabilities

/**
 * The screen abilities, inside Ash: the accessibility service's tools and the task island. [ScreenBridge] is the face
 * the rest of Ash uses; this is what it calls.
 */
object ScreenHost {
    /** The island stays out of a capture of the main screen, and lets the agent's own touches pass under it. */
    fun run(ctx: Context, name: String, args: JSONObject): CapResult {
        val c = (ScreenCapabilities.list + ScreenCapabilities.hidden).firstOrNull { it.name == name }
            ?: return CapResult.fail("the phone has no capability $name")
        if (!c.available(ctx)) return CapResult.fail("$name is not available right now (the accessibility service is off)")
        val call = {
            try { c.run(ctx, args) } catch (e: Throwable) {
                Log.w("ash.screen", "$name failed", e)
                CapResult.fail("$name failed: ${e.message ?: e.javaClass.simpleName}")
            }
        }
        return try {
            when {
                name in setOf("screen.see", "screen.capture") && args.optInt("display", 0) != 0 -> call()
                name in setOf("screen.see", "screen.capture") -> NativeIsland.withoutOverlay(call)
                name !in setOf("screen.read", "screen.touch_status", KeepAliveSwitches.CAPABILITY) -> NativeIsland.withTouchPassthrough(call)
                else -> call()
            }
        } catch (e: IllegalStateException) { CapResult.fail(e.message ?: "owner_input_busy") }
    }

    /** {foreground_package, epoch}; [settle] first waits for the screen to settle. */
    fun screenState(settle: Boolean): JSONObject {
        val service = A11yService.instance
        if (settle) service?.awaitIdle(250, 1000)
        return JSONObject().put("foreground_package", service?.foregroundPackage().orEmpty()).put("epoch", A11yService.screenEpoch.get())
    }
}

/** Between the island and the rest of Ash: what the island asks of Ash, and what the screen side says when its state changes. */
internal object ScreenLink : NativeIsland.Ash {
    @Volatile var app: Context? = null
    private val main = Handler(Looper.getMainLooper())
    private val waiting = ConcurrentHashMap<String, (Boolean, String) -> Unit>()
    private var model: JSONObject? = null

    init { NativeIsland.ash = this }

    /** Tell Ash: the service came or went, the island appeared or left. */
    fun changed() { ScreenBridge.changed() }
    /**
     * The accessibility service connected, went away, or was reconnected (the system does so, e.g. while a testing tool
     * holds the screen): the island's windows went with the old one, so it is drawn again here, from the last frame.
     */
    fun serviceChanged() {
        changed()
        main.post { app?.let { apply(it) } }
    }

    fun island(ctx: Context, state: String) {
        val value = runCatching { JSONObject(state) }.getOrNull() ?: return
        main.post {
            NativeIsland.ashInFront = value.optBoolean("ash_in_front")
            val shown = value.optJSONObject("model")
            if (!value.optBoolean("show") || shown == null) { model = null; NativeIsland.hide(); return@post }
            model = shown
            apply(ctx)
        }
    }
    /** The latest frame again (the island re-applies it when it may be shown again, or after a local answer). */
    private fun apply(ctx: Context) {
        val m = model ?: return
        NativeIsland.update(ctx, JSONObject(m.toString())) { main.post { apply(ctx) } }
    }

    /** The outcome of an island action that asked for one: {request, ok, message}. */
    fun result(json: String) {
        val r = runCatching { JSONObject(json) }.getOrNull() ?: return
        waiting.remove(r.optString("request"))?.invoke(r.optBoolean("ok"), r.optString("message"))
    }

    private fun tell(action: JSONObject, done: ((Boolean, String) -> Unit)? = null) {
        if (done != null) { val id = UUID.randomUUID().toString(); waiting[id] = done; action.put("request", id) }
        try { ScreenBridge.islandAction(action) }
        catch (_: Exception) { action.optString("request").takeIf { it.isNotEmpty() }?.let { waiting.remove(it) }; done?.invoke(false, "Ash 未连接，请稍后重试") }
    }
    override fun dismiss(turn: String) = tell(JSONObject().put("action", "dismiss").put("turn", turn))
    override fun stop(turn: String) = tell(JSONObject().put("action", "stop").put("turn", turn))
    override fun open() = tell(JSONObject().put("action", "open"))
    override fun answer(id: String, choice: String, text: String?, done: (Boolean, String) -> Unit) =
        tell(JSONObject().put("action", "answer").put("id", id).put("choice", choice).apply { if (text != null) put("text", text) }, done)
    override fun send(text: String, clientId: String, done: (Boolean, String) -> Unit) =
        tell(JSONObject().put("action", "send").put("text", text).put("client_id", clientId), done)
    override fun shown(value: Boolean) = changed()
}
