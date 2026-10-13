package ai.ash.ui

import ai.ash.R
import ai.ash.host.AppState
import ai.ash.host.Notifications
import ai.ash.host.TaskStatus
import ai.ash.human.HumanSend
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import org.json.JSONObject

/**
 * The screen leases the owner has given (the kernel's `service:gate` `lease.state`, pushed as `present{status/lease}`): which agent may
 * operate the real screen and until when. The hub is the only judge of time and recall; this only shows what it says and sends
 * the owner's 「收回」.
 *
 * While a lease is in force one of three things shows it: a small floating ball over other apps ([LeaseOrb], when Ash may draw over
 * them), else an ongoing notification with a 「收回权限」 button; and when Ash is itself in front, the chat shows a thin bar instead
 * ([ChatScreen]), so the ball steps aside.
 */
object LeaseState {
    private const val TAG = "ash.lease"
    private const val NOTE = "screen-lease"
    private const val ID = 8

    data class Lease(val id: String, val agent: String, val name: String, val kind: String, val purpose: String, val grantedAt: Long,
        val expiresAt: Long) {
        fun remaining(now: Long = System.currentTimeMillis()): Long = (expiresAt - now).coerceAtLeast(0)
        fun clock(now: Long = System.currentTimeMillis()): String = remaining(now).let { ms -> "%d:%02d".format(ms / 60_000, ms / 1000 % 60) }
    }

    private val main = Handler(Looper.getMainLooper())
    @Volatile var leases: List<Lease> = emptyList(); private set
    private var app: Context? = null
    private val listeners = ArrayList<() -> Unit>()
    private val tick = object : Runnable { override fun run() { if (leases.isNotEmpty()) { changed(); main.postDelayed(this, 1_000) } } }

    fun onChange(l: () -> Unit) { listeners.add(l) }
    fun removeChange(l: () -> Unit) { listeners.remove(l) }

    /** What the hub pushed: the whole list. Any thread. */
    fun accept(ctx: Context, body: JSONObject): Boolean {
        val a = body.optJSONArray("leases") ?: return false
        val next = ArrayList<Lease>()
        for (i in 0 until a.length()) {
            val o = a.optJSONObject(i) ?: continue
            next.add(Lease(o.optString("id"), o.optString("agent"), o.optString("name").ifBlank { o.optString("agent") }.take(40), o.optString("kind"),
                o.optString("purpose").take(120), o.optLong("granted_at"), o.optLong("expires_at")))
        }
        main.post {
            app = ctx.applicationContext
            leases = next.sortedBy { it.expiresAt }
            main.removeCallbacks(tick)
            if (leases.isNotEmpty()) main.post(tick) else changed()
        }
        return true
    }

    /** Ash came to the front or left it: the ball and the bar swap. */
    fun refresh() { main.post { changed() } }

    private fun changed() {
        val ctx = app ?: return
        val now = System.currentTimeMillis()
        // The hub ends a lease on its own clock; one that only looks over here is dropped until its next push.
        val live = leases.filter { it.expiresAt > now - 2_000 }
        val canDraw = Settings.canDrawOverlays(ctx)
        if (live.isNotEmpty() && canDraw && !AppState.inFront) LeaseOrb.show(ctx, live) else LeaseOrb.hide()
        if (live.isNotEmpty() && !canDraw) notice(ctx, live) else clearNotice(ctx)
        listeners.toList().forEach { it() }
    }

    /** The owner takes the lease(s) back: [id] one, null all. Any thread; the hub's next push shows the result. */
    fun revoke(ctx: Context, id: String? = null) {
        Thread({
            try {
                HumanSend.send(ctx, JSONObject().put("to", "service:gate").put("kind", "request").put("word", "lease.revoke")
                    .put("body", JSONObject().apply { if (id != null) put("id", id) }).put("wait", true))
            } catch (e: Exception) {
                Log.w(TAG, "revoke failed", e)
                main.post { Toast.makeText(ctx.applicationContext, "没能收回，再点一次试试", Toast.LENGTH_SHORT).show() }
            }
        }, "ash-lease-revoke").start()
    }

    // ---- the notification, when the ball cannot be drawn ----

    private fun notice(ctx: Context, live: List<Lease>) {
        Notifications.createChannels(ctx)
        val first = live.first()
        val revoke = PendingIntent.getBroadcast(ctx, ID, Intent(ctx, LeaseRevokeReceiver::class.java).setData(Uri.parse("ash://lease-revoke")),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val open = PendingIntent.getActivity(ctx, ID, Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val b = Notifications.builder(ctx, Notifications.CH_STATUS)
            .setContentTitle("${first.name} 正在操作你的手机").setContentText(if (live.size > 1) "共 ${live.size} 项屏幕授权，点这里回到 Ash" else "屏幕授权剩余时间见右侧，点这里回到 Ash")
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_STATUS)
            .setUsesChronometer(true).setChronometerCountDown(true).setWhen(first.expiresAt).setShowWhen(true)
            .addAction(Notification.Action.Builder(null, "收回权限", revoke).build())
        ctx.getSystemService(NotificationManager::class.java).notify(NOTE, ID, b.build())
    }

    private fun clearNotice(ctx: Context) { ctx.getSystemService(NotificationManager::class.java).cancel(NOTE, ID) }
}

/** 「收回权限」 on the notification. */
class LeaseRevokeReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) { LeaseState.revoke(ctx.applicationContext) }
}
