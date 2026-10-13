package ai.ash.host

import ai.ash.caps.screen.Screen
import android.app.Activity
import android.app.Application
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import java.util.concurrent.atomic.AtomicInteger

/**
 * Putting one of Ash's screens in front of the owner when Ash is not in front (SPEC-05 §7). From Android 10 the system
 * silently drops such a start unless the app is exempt: it has a window in view, its accessibility service runs, or the
 * owner granted it the overlay permission. Without an exemption the screen waits behind a notification the owner taps
 * (a tap is always allowed).
 */
object BackgroundLaunch {
    enum class Route { DIRECT, NOTIFY }

    /** Pure rule: a start is made directly when the system will let it through, otherwise it is offered in a notice. */
    fun route(sdk: Int, visible: Boolean, accessibilityOn: Boolean, overlayGranted: Boolean): Route =
        if (sdk < 29 || visible || accessibilityOn || overlayGranted) Route.DIRECT else Route.NOTIFY

    private val started = AtomicInteger(0)

    /** One of the app's screens is in view (counted from [install]). */
    val visible: Boolean get() = started.get() > 0

    fun install(app: Application) {
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) { started.incrementAndGet() }
            override fun onActivityStopped(activity: Activity) { started.updateAndGet { (it - 1).coerceAtLeast(0) } }
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }

    fun route(ctx: Context): Route = route(Build.VERSION.SDK_INT, visible, Screen.accessibility(), Settings.canDrawOverlays(ctx))

    /** Starts [intent] now when an exemption holds, otherwise posts a notice that starts it when tapped. */
    fun start(ctx: Context, intent: Intent, title: String, text: String): Route {
        val app = ctx.applicationContext
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (route(app) == Route.DIRECT && runCatching { app.startActivity(intent) }.isSuccess) return Route.DIRECT
        val tap = PendingIntent.getActivity(app, intent.component?.className.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        Notifications.notice(app, intent.component?.className ?: "launch", title, text, tap)
        return Route.NOTIFY
    }
}
