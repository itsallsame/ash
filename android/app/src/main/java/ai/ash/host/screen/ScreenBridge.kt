package ai.ash.host.screen

import ai.ash.host.TaskStatus
import ai.ash.screen.ScreenLink
import ai.ash.screen.island.NativeIsland
import ai.ash.ui.HomeActivity
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import ai.ash.caps.config.ScreenRecovery

/**
 * Ash's face to the task island, which the accessibility service draws: the island is told what to show, and the owner's
 * actions on it come back here. The screen tools are capabilities ([ai.ash.caps.screen.ScreenCapabilities]), not part of this.
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

    // ---- the island ----

    /** The island can be drawn (the accessibility service, or the overlay permission). */
    fun islandReady() = app?.let { NativeIsland.ready(it) } ?: false
    fun islandShown() = NativeIsland.showing()

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
}
