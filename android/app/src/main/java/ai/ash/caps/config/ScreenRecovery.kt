package ai.ash.caps.config

import ai.ash.caps.screen.Screen
import ai.ash.host.Notifications
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.provider.Settings

/**
 * Notices when the system stopped Ash's accessibility service (a maker's background cleaning does): the switch stays on in
 * settings, but Android does not start the service again by itself.
 *
 * The accessibility service is a host service: the owner turns it on and off. Ash only tells them, in one notice whose tap
 * opens the accessibility list, where switching 「Ash」 off and on again brings it back. Ash writes no setting for it.
 */
object ScreenRecovery {
    private const val NOTICE = "screen-down"
    private const val CHECK_MS = 15_000L
    /** A reconnecting service is not a stopped one: wait this long before telling the owner. */
    private const val DOWN_MS = 20_000L
    private val main = Handler(Looper.getMainLooper())
    private var app: Context? = null
    private var downSince = 0L
    private var told = false
    private var started = false

    fun start(ctx: Context) {
        if (started) return
        started = true; app = ctx.applicationContext
        main.postDelayed(::check, CHECK_MS)
    }

    private fun check() {
        val ctx = app ?: return
        main.postDelayed(::check, CHECK_MS)
        UpgradeRecovery.observe(ctx, Screen.accessibility(), Screen.switchedOn(ctx))
        val down = Screen.switchedOn(ctx) && !Screen.accessibility()
        val now = System.currentTimeMillis()
        if (!down) {
            downSince = 0
            if (told) { told = false; Notifications.cancelNotice(ctx, NOTICE) }
            return
        }
        if (downSince == 0L) { downSince = now; return }
        if (now - downSince < DOWN_MS || told) return
        told = true
        askOwner(ctx, "看屏幕的能力掉了", "系统停掉了 Ash 的无障碍。点这里，在列表里把「Ash」关掉再打开，就能接上")
    }

    /** One notice that opens the accessibility list on a tap. */
    internal fun askOwner(ctx: Context, title: String, text: String, tag: String = NOTICE) {
        val tap = PendingIntent.getActivity(ctx, 3, Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        Notifications.notice(ctx, tag, title, text, tap)
    }
}
