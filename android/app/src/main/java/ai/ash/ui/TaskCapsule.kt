package ai.ash.ui

import android.content.Context
import android.os.Looper
import ai.ash.host.AppState
import ai.ash.host.TaskFrame
import ai.ash.host.TaskStatus
import ai.ash.host.screen.ScreenBridge

/** The task island over other apps. The screen side draws it; Ash tells it what to show (see [ScreenBridge]). */
object TaskCapsule {
    private const val PREFS = "ash_island"
    /** The island is on screen for the owner now: what it shows needs no notification. */
    fun showing(): Boolean = ScreenBridge.islandShown()
    /** The island can be shown at all; otherwise a running task is a notification. */
    fun ready(): Boolean = ScreenBridge.islandReady()

    /** The owner keeps the resident entry (「常驻入口」, on unless turned off). */
    fun residentKept(ctx: Context): Boolean = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("resident", true)
    fun setResidentKept(ctx: Context, on: Boolean) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("resident", on).apply()
        TaskStatus.refresh()
    }
    /** The resident entry is shown between tasks: kept. */
    fun residentOn(ctx: Context): Boolean = residentKept(ctx)

    internal fun update(ctx: Context, frame: TaskFrame, elapsed: Long, stale: Boolean, interactive: Boolean, canStop: Boolean, notice: String?) {
        check(Looper.myLooper() == Looper.getMainLooper())
        // The helper lays its own pending answers over the cards.
        ScreenBridge.island(IslandPresentation.project(frame, elapsed, stale, interactive, canStop, notice, emptyMap(), System.currentTimeMillis()), AppState.homeVisible)
    }
    /** The resident entry: no task, only the way to talk to Ash. */
    fun resident(canSend: Boolean) = ScreenBridge.island(IslandPresentation.resident(canSend), AppState.homeVisible)
    fun hide() = ScreenBridge.island(null, AppState.homeVisible)
}
