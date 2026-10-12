package ai.ash.caps.config

import ai.ash.caps.Events
import ai.ash.ui.Checkup
import ai.ash.ui.OnboardingPlan
import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Tells the kernel how the phone's checkup stands (the device event `checkup.changed`: counts and short phrases per part, no contents),
 * so her status app, which cannot see the phone's own checkup page, can say it. Sent when the summary changes (looked at each time one of
 * the app's screens comes to the front, as [ConfigWatch] does) and once each time the phone connects to the kernel, which holds only
 * the last one. A look that finds nothing new sends nothing, and two looks are never less than [MIN_GAP_MS] apart: the kernel counts
 * events like this one and calls too many of them a part that flaps.
 */
object CheckupWatch {
    private const val TAG = "ash.checkup"
    private const val PREFS = "ash.checkup.watch"
    const val MIN_GAP_MS = 30_000L
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "ash-checkup-watch").apply { isDaemon = true } }
    @Volatile private var lastLook = 0L

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

    /** The phone connected to the kernel: it holds no summary yet (or an older one): send the present one whatever was sent before. */
    fun connected(ctx: Context) = check(ctx, force = true)

    fun check(ctx: Context, force: Boolean = false) {
        val app = ctx.applicationContext
        val now = System.currentTimeMillis()
        if (!force) { if (now - lastLook < MIN_GAP_MS) return; lastLook = now }
        runCatching { executor.execute { runCatching { send(app, force) }.onFailure { Log.w(TAG, "checkup look failed: ${it.javaClass.simpleName}") } } }
    }

    private fun send(ctx: Context, force: Boolean) {
        val body = body(Checkup.read(ctx))
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val sig = signature(body)
        if (!force && prefs.getString("sent", null) == sig) return
        // Remembered only once queued, so one that could not be is tried again at the next look.
        if (runCatching { Events.emit(ctx, "checkup.changed", body) }.isSuccess) prefs.edit().putString("sent", sig).apply()
    }

    /** The summary as the kernel's word takes it: every part of [OnboardingPlan.PARTS] in its order, with the phone's own short phrase (without 「去修」: the app draws that). */
    fun body(items: List<Checkup.Item>): JSONObject {
        val summary = Checkup.summarize(items)
        val groups = JSONArray()
        for (p in OnboardingPlan.PARTS) {
            val todo = summary.todo(p)
            groups.put(JSONObject().put("id", p.id).put("title", p.title).put("todo", todo).put("optional", Checkup.optional(p))
                .put("text", Checkup.cellText(p, todo).removeSuffix(" · 去修").take(40)))
        }
        return JSONObject().put("todo", summary.todo).put("groups", groups)
    }

    /** What changing means: the count or the count of any part; the phrases follow from them. */
    fun signature(body: JSONObject): String =
        "${body.getInt("todo")}:" + (0 until body.getJSONArray("groups").length()).joinToString(",") { body.getJSONArray("groups").getJSONObject(it).let { g -> "${g.getString("id")}=${g.getInt("todo")}" } }
}
