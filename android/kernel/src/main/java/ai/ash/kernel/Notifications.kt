package ai.ash.kernel

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Bundle

/** The words of the notification, one place; pure so a unit test can pin them. */
object KernelText {
    const val RUNNING = "正在运行"
    const val STARTING = "正在启动"
    const val INSTALLING = "正在安装运行环境…"
    const val RESTARTING = "正在重启"
    const val STOPPED = "已停止"
    const val RETRYING = "Ash 反复退出，正在重试"
    const val ERROR = "出错了"

    fun error(detail: String?): String = if (detail.isNullOrBlank()) ERROR else "$ERROR：$detail"

    /** The default line of a supervisor state (the core's own status text replaces it while the core runs). */
    fun forState(state: KernelState, detail: String? = null): String = when (state) {
        KernelState.STARTING -> STARTING
        KernelState.INSTALLING -> INSTALLING
        KernelState.RUNNING -> RUNNING
        KernelState.RESTARTING -> RESTARTING
        KernelState.STOPPED -> STOPPED
        KernelState.ERROR -> error(detail)
    }

    /**
     * The line for a status.set from the core: its own sentence is shown as it is; blank, or one of the bare machine words
     * (the core's liveness beat says "running"), becomes the Chinese line of that state.
     */
    fun fromCore(text: String, state: String): String {
        val t = text.trim()
        if (t.isNotEmpty() && t.lowercase() !in MACHINE_WORDS) return t
        return when (state) {
            "starting" -> STARTING
            "stopping" -> "正在停止"
            "degraded" -> "运行不稳定"
            else -> RUNNING
        }
    }

    private val MACHINE_WORDS = setOf("running", "starting", "degraded", "stopping", "ok", "alive")
}

/** The one notification of the foreground service: status text only; a tap opens the hand app. */
object Notifications {
    /**
     * A channel's importance cannot be raised or lowered once created, and the first builds made "ash.kernel.status" at a level
     * the phone still shows in the status bar; so the minimum-importance channel is a new id and the old one is deleted.
     */
    const val CHANNEL = "ash.kernel.status.v2"
    val RETIRED_CHANNELS = listOf("ash.kernel.status")
    /**
     * MIUI's own extra (an android.graphics.drawable.Icon): the app icon its notification shade draws instead of the launcher
     * icon cache, which has no entry for a package with no launcher activity. Other systems ignore an unknown extra.
     */
    const val MIUI_APP_ICON = "miui.appIcon"
    const val ID = 1
    /** Channels the pairing guide uses: progress (silent, same as the status channel) and a ringing one for what the owner must do now. */
    const val CH_STATUS = CHANNEL
    const val CH_URGENT = "ash.kernel.urgent"
    /** The hand app's chat page (its only launcher activity). */
    const val HOME_ACTIVITY = "ai.ash.ui.HomeActivity"

    fun createChannel(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Ash 内核常驻", NotificationManager.IMPORTANCE_MIN).apply {
                setShowBadge(false); setSound(null, null); enableVibration(false)
                description = "让 Ash 在后台保持运行；不响、不弹出，可以放心折叠。"
                lockscreenVisibility = Notification.VISIBILITY_SECRET
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_URGENT, "Ash 内核配对", NotificationManager.IMPORTANCE_HIGH).apply { setShowBadge(false) },
        )
        // A channel still carrying a running service's notification cannot be deleted (SecurityException); the next start retires it.
        for (old in RETIRED_CHANNELS) runCatching { nm.deleteNotificationChannel(old) }
    }

    /** A builder on [channel] with Ash's icon, for the pairing guide. */
    fun builder(ctx: Context, channel: String): Notification.Builder =
        Notification.Builder(ctx, channel).setSmallIcon(R.drawable.ic_stat_ash)
            .addExtras(Bundle().apply { putParcelable(MIUI_APP_ICON, Icon.createWithResource(ctx, R.mipmap.ic_launcher)) })

    fun build(ctx: Context, text: String): Notification {
        val b = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_ash)
            .setContentTitle("Ash 内核")
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(Notification.PRIORITY_MIN)
            .setContentText(text)
            .setOngoing(true)
            .addExtras(Bundle().apply {
                putParcelable(MIUI_APP_ICON, Icon.createWithResource(ctx, R.mipmap.ic_launcher))
            })
        // Explicit component: getLaunchIntentForPackage is null on Android 11+ without package visibility, and the tap would do nothing.
        val open = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            .setComponent(ComponentName(HandConnector.HAND_PACKAGE, HOME_ACTIVITY))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        b.setContentIntent(PendingIntent.getActivity(ctx, 1, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        return b.build()
    }

    fun update(ctx: Context, text: String) {
        ctx.getSystemService(NotificationManager::class.java).notify(ID, build(ctx, text))
    }
}
