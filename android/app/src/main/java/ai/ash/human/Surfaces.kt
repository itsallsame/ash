package ai.ash.human

import ai.ash.host.AppState
import ai.ash.host.HandRuntime
import ai.ash.host.Present
import ai.ash.host.TaskStatus
import ai.ash.host.screen.ScreenBridge
import ai.ash.link.PresentOutcome
import ai.ash.ui.HomeActivity
import ai.ash.widget.WidgetHost
import android.content.Context
import android.content.Intent
import org.json.JSONObject

/** The phone's surfaces of the human channel (SPEC-03 §5.4), each one the handler it had before, now driven by `present`. */
internal object Surfaces {
    fun android(ctx: Context, chat: ChatBridge): HumanChannel {
        val app = ctx.applicationContext
        // What a present needs is running before it is shown: the hand's runtime (the island layer gets its context there).
        fun ready(handler: SurfaceHandler) = SurfaceHandler { op, body -> HandRuntime.start(app); handler.present(op, body) }
        return HumanChannel(linkedMapOf(
            "chat" to SurfaceHandler { op, body -> chat.present(op, body) },
            "notification" to ready { op, body ->
                val id = body.optString("id")
                when (op) {
                    "show" -> Present.show(app, body)
                    "hide" -> if (Present.hide(app, id)) PresentOutcome(true) else PresentOutcome(false, null, "internal", "store_failed")
                    "alert" -> { Present.alert(app, id); PresentOutcome(true) }
                    else -> unknown("notification", op)
                }
            },
            "island" to ready { op, _ ->
                if (op == "query") PresentOutcome(true, JSONObject().put("showing", ScreenBridge.islandShown())) else unknown("island", op)
            },
            "widget" to ready { op, body ->
                when (op) {
                    "state" -> WidgetHost.accept(app, body)
                    "preview" -> WidgetHost.preview(app, body)
                    else -> unknown("widget", op)
                }
            },
            "status" to ready { op, body ->
                if (op != "frame") unknown("status", op)
                else if (TaskStatus.accept(app, body)) PresentOutcome(true) else PresentOutcome(false, null, "bad_request", "invalid task frame")
            },
        ))
    }

    private fun unknown(surface: String, op: String) = PresentOutcome(false, null, "unavailable", "$surface has no op $op")
}

/** Brings Ash's chat page up from wherever it is (a `chat` present, or the notification and island taps). */
internal class HomeLauncher(private val ctx: Context) : ChatBridge.ChatUi {
    override fun bringToFront(): Boolean {
        if (AppState.homeVisible) return true
        return try {
            ctx.startActivity(Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            true
        } catch (_: Exception) { false }
    }
}
