package ai.ash.host.screen

import ai.ash.host.TaskStatus
import ai.ash.host.cap.CapResult
import ai.ash.host.cap.Capability
import ai.ash.screen.ScreenCapabilities
import ai.ash.screen.ScreenHost
import ai.ash.screen.ScreenLink
import ai.ash.screen.a11y.A11yService
import ai.ash.screen.island.NativeIsland
import ai.ash.ui.HomeActivity
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/**
 * The rest of Ash's face to the screen abilities (the accessibility service's tools and the task island), which live in
 * this same app: the tools join the phone's manifest, the island is told what to show, and the owner's actions on it
 * come back here.
 */
object ScreenBridge {
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var app: Context? = null
    private var lastIsland = ""

    fun start(ctx: Context) {
        app = ctx.applicationContext
        ScreenLink.app = app
        main.post { lastIsland = ""; TaskStatus.refresh() }
        ScreenRecovery.start(ctx)
    }

    /** The accessibility service came or went, or the island appeared or left. */
    fun changed() {
        main.post { TaskStatus.refresh() }
        // The screen tools are offered only while the accessibility service runs: the kernel is told the new manifest.
        ai.ash.link.Link.manifestChanged()
    }

    // ---- what Ash asks of the screen side ----

    /** The accessibility switch is on in system settings (whether or not the service is running). */
    fun switchedOn(ctx: Context): Boolean = android.provider.Settings.Secure.getString(ctx.contentResolver,
        android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty().split(':').any { it.startsWith("${ctx.packageName}/") }
    /** The accessibility service is on: Ash can see and operate the screen. */
    fun accessibility() = A11yService.instance != null
    /** The island can be drawn (the accessibility service, or the overlay permission). */
    fun islandReady() = app?.let { NativeIsland.ready(it) } ?: false
    fun islandShown() = NativeIsland.showing()

    private val tools: List<Capability> by lazy { ScreenCapabilities.list.map { ScreenTool(it) } }
    fun tools(): List<Capability> = tools +
        if (A11yService.instance != null && A11yService.canScreenshot) listOf(ScreenshotTool) else emptyList()

    fun call(name: String, args: JSONObject): CapResult {
        val ctx = app ?: return CapResult.fail("$name is not available right now: Ash has not started")
        return ScreenHost.run(ctx, name, args)
    }
    fun screenState(settle: Boolean): JSONObject = ScreenHost.screenState(settle)

    /** Ash's own input to other apps (opening an app, a key) passes under the island; refused while the owner types. */
    fun <T> withTouchPassthrough(action: () -> T): T = if (app == null) action() else NativeIsland.withTouchPassthrough(action)

    /** What the island shows. Sent when it changes, and once more after a restart of the screen service. */
    fun island(model: JSONObject?, ashInFront: Boolean) {
        val ctx = app ?: return
        val state = JSONObject().put("show", model != null).put("ash_in_front", ashInFront).apply { if (model != null) put("model", model) }.toString()
        if (state == lastIsland) return
        lastIsland = state
        ScreenLink.island(ctx, state)
    }

    // ---- what the owner did on the island ----

    /** One action from the island: {action, turn?, request?, ...}; a request id asks for a result. */
    fun islandAction(a: JSONObject) { main.post { act(a) } }

    private fun act(a: JSONObject) {
        val request = a.optString("request")
        val reply: (Boolean, String) -> Unit = { ok, message ->
            if (request.isNotEmpty()) ScreenLink.result(JSONObject().put("request", request).put("ok", ok).put("message", message).toString())
        }
        when (a.optString("action")) {
            "dismiss" -> TaskStatus.dismiss(a.optString("turn"))
            "stop" -> TaskStatus.stop(a.optString("turn"))
            "open" -> app?.let { it.startActivity(Intent(it, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
            "answer" -> TaskStatus.answerCard(a.optString("id"), a.optString("choice"), if (a.has("text")) a.optString("text") else null, reply)
            "send" -> TaskStatus.sendInput(a.optString("text"), a.optString("client_id"), reply)
            else -> reply(false, "未知操作")
        }
    }

    /** One of the screen tools, as Ash's capability: it runs through [ScreenHost] (the island steps aside for it). */
    private class ScreenTool(private val real: Capability) : Capability {
        override val name: String = real.name
        override val description: String = real.description
        override val schema: JSONObject = real.schema
        override val confirm: Boolean = real.confirm
        override fun available(ctx: Context) = real.available(ctx)
        override fun run(ctx: Context, args: JSONObject) = ScreenHost.run(ctx, name, args)
    }
}
