package ai.ash.host

import ai.ash.link.HumanSend
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import org.json.JSONObject
import java.util.UUID

/** The status notification pauses through the same durable Core command as Settings. It never resumes. */
class NotificationPauseReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != ACTION_PAUSE) return
        val pending = goAsync()
        Thread {
            try {
                // TODO(T11b-2): a human channel `send`; until then HumanSend fails.
                val result = HumanSend.send(JSONObject()
                    .put("to", "service:admin").put("kind", "request").put("word", "pause")
                    .put("body", JSONObject()).put("client_id", UUID.randomUUID().toString()).put("wait", true))
                val accepted = result.optString("id")
                val reply = result.optJSONObject("reply")
                if (accepted.isBlank() || reply?.optString("reply_to") != accepted ||
                    reply.optString("from") != "service:admin" || reply.optString("word") != "pause" ||
                    reply.optJSONObject("body")?.optJSONObject("result")?.optBoolean("paused") != true)
                    Notifications.presentFailure(ctx.applicationContext, "status-pause")
            } catch (e: Exception) {
                Log.w("ash.pause", "notification pause was not confirmed", e)
                Notifications.presentFailure(ctx.applicationContext, "status-pause")
            } finally { pending.finish() }
        }.start()
    }

    companion object { const val ACTION_PAUSE = "ai.ash.NOTIFICATION_PAUSE" }
}
