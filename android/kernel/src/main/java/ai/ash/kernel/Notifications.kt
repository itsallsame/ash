package ai.ash.kernel

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context

/** The one notification of the foreground service: status text only; a tap opens the hand app. */
object Notifications {
    const val CHANNEL = "ash.kernel.status"
    const val ID = 1

    fun createChannel(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Ash 运行中", NotificationManager.IMPORTANCE_MIN).apply {
                setShowBadge(false); setSound(null, null); enableVibration(false)
            },
        )
    }

    fun build(ctx: Context, text: String): Notification {
        val b = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_ash)
            .setContentTitle("Ash")
            .setContentText(text)
            .setOngoing(true)
        ctx.packageManager.getLaunchIntentForPackage(HandConnector.HAND_PACKAGE)?.let {
            b.setContentIntent(PendingIntent.getActivity(ctx, 1, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        }
        return b.build()
    }

    fun update(ctx: Context, text: String) {
        ctx.getSystemService(NotificationManager::class.java).notify(ID, build(ctx, text))
    }
}
