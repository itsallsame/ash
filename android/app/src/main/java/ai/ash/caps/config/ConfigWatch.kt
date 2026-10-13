package ai.ash.caps.config

import ai.ash.caps.Events
import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Tells the kernel when one of the app's permissions or switches changed (the device event `config.changed`). Android
 * does not announce these, so the state is read again whenever one of the app's screens comes to the front (the owner
 * has just been in a settings page) and whenever the accessibility service comes or goes, and compared with what the
 * kernel was last told. The first look only records. Reading may wait on other apps (Health Connect), so it never runs
 * on the main thread.
 */
object ConfigWatch {
    private const val TAG = "ash.config"
    private const val PREFS = "ash.config.watch"
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "ash-config-watch").apply { isDaemon = true } }

    /** Looks again each time an activity of the app is resumed. */
    fun install(app: Application) {
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) { check(app) }
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }

    /** Reads the state of every item and sends `config.changed` for each that differs from the last one the kernel was told. */
    fun check(ctx: Context) {
        val app = ctx.applicationContext
        runCatching { executor.execute { runCatching { compare(app) }.onFailure { Log.w(TAG, "config check failed: ${it.javaClass.simpleName}") } } }
    }

    private fun compare(ctx: Context) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val first = prefs.all.isEmpty()
        val edit = prefs.edit()
        for (item in ConfigStatus.all(ctx) + KeepAliveStatus.items(ctx)) {
            if (prefs.getString(item.item, null) == item.state) continue
            // Remembered only once the event is queued, so one that could not be is tried again at the next look.
            if (!first) {
                val sent = runCatching { Events.emit(ctx, "config.changed", JSONObject().put("item", item.item).put("state", item.state)) }.isSuccess
                if (!sent) continue
            }
            edit.putString(item.item, item.state)
        }
        edit.apply()
    }
}
