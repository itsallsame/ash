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
 * The lease itself (it exists, until when, one button to end it) is shown on the island: the resident pill's right end, or the foot of a
 * task's card ([IslandPresentation]); when the island cannot be shown, an ongoing notification with a 「收回权限」 button stands in; and
 * when Ash is itself in front, the chat shows a thin bar ([ChatScreen]). The floating ball ([LeaseOrb]) is not that: it shows only
 * while the agent is really operating the screen (the hub says when it last did, [Lease.lastActionAt]) and for a few seconds after.
 */
object LeaseState {
    private const val TAG = "ash.lease"
    private const val NOTE = "screen-lease"
    private const val ID = 8
    /** How long the ball stays after the agent's last action on the screen: longer than the agent thinks between two actions. */
    const val OPERATING_MS = 60_000L

    data class Lease(val id: String, val agent: String, val name: String, val kind: String, val purpose: String, val grantedAt: Long,
        val expiresAt: Long, val lastActionAt: Long? = null) {
        /** The agent did something on the screen a moment ago: the floating ball is up. */
        fun operating(now: Long = System.currentTimeMillis()): Boolean = lastActionAt != null && now - lastActionAt < OPERATING_MS
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
                o.optString("purpose").take(120), o.optLong("granted_at"), o.optLong("expires_at"), if (o.isNull("last_action_at")) null else o.optLong("last_action_at")))
        }
        main.post {
            app = ctx.applicationContext
            leases = next.sortedBy { it.expiresAt }
            main.removeCallbacks(tick)
            if (leases.isNotEmpty()) main.post(tick) else changed()
            // The island carries the lease's state: it draws it again now (its own clock keeps it going).
            TaskStatus.refresh()
        }
        return true
    }

    /** What the island prints for the lease: the time left as m:ss of the one that ends first, "" when there is none. */
    fun islandClock(): String = leases.firstOrNull { it.expiresAt > System.currentTimeMillis() }?.clock() ?: ""

    /** Ash came to the front or left it: the ball and the bar swap. */
    fun refresh() { main.post { changed() } }

    private fun changed() {
        val ctx = app ?: return
        val now = System.currentTimeMillis()
        // The hub ends a lease on its own clock; one that only looks over here is dropped until its next push.
        val live = leases.filter { it.expiresAt > now - 2_000 }
        val canDraw = Settings.canDrawOverlays(ctx)
        // The ball: only while the agent is really operating the screen (and a moment after), never for the lease alone.
        if (live.any { it.operating(now) } && canDraw && !AppState.inFront) LeaseOrb.show(ctx, live, operating = true)
        else if (!LeaseOrb.isOpen()) LeaseOrb.hide()
        else if (live.isEmpty()) LeaseOrb.hide()
        // The island shows the lease; when it cannot (no way to draw it, or the owner turned the resident entry off), a notice does.
        if (live.isNotEmpty() && !(TaskCapsule.ready() && TaskCapsule.residentKept(ctx))) notice(ctx, live) else clearNotice(ctx)
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
