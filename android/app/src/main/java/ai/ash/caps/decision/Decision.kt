package ai.ash.caps.decision

import ai.ash.caps.CapResult
import ai.ash.caps.Capabilities
import ai.ash.caps.screen.Screen
import ai.ash.host.AppState
import ai.ash.ui.HomeActivity
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/**
 * What the kernel's reflex asks of the phone to decide whether to bring Ash back (`decision.*`, see
 * [DecisionCapabilities]), and the bookkeeping behind it: which screen state a decision saw. Every other capability call
 * passes through [call] so that bookkeeping sees it. The virtual screen is the kernel host's, and so is its bookkeeping.
 */
object Decision {
    private val state = ScreenDecisionState()
    private val main = Handler(Looper.getMainLooper())

    @Synchronized fun surface(turn: String): JSONObject {
        state.beginTurn(turn)
        return JSONObject().put("home_visible", AppState.homeVisible).put("page_live", AppState.homePageLive)
            .put("visibility_epoch", AppState.visibilityEpoch.get())
    }

    /** Screen changes, as the accessibility service counts them, with Ash's own turns and visibility. */
    private fun epoch(screen: JSONObject): Long = state.epoch + screen.optLong("epoch") + AppState.visibilityEpoch.get()
    private fun foreground(ctx: Context, screen: JSONObject): String = if (AppState.homeVisible) ctx.packageName else screen.optString("foreground_package")

    fun snapshot(ctx: Context): JSONObject {
        // App transitions can still be settling after apps.open's acknowledgment.
        val screen = Screen.screenState(settle = true)
        return synchronized(state) {
            JSONObject().put("foreground_package", foreground(ctx, screen)).put("state_epoch", epoch(screen))
        }
    }

    /** Runs capability [capability] for the kernel's call, keeping the decision state in step with what it did to the screens. */
    fun call(ctx: Context, capability: String, args: JSONObject, turn: String): CapResult {
        if (capability.startsWith("screen.") || capability in SCREEN_CHANGERS) state.screenChanged()
        return Capabilities.call(ctx, capability, args, turn)
    }

    /** Capabilities that change what is on the owner's screen without being `screen.*`. */
    private val SCREEN_CHANGERS = setOf("apps.open_direct", "apps.open_url", "settings.open", "x.android.browser.show")


    fun returnToAsh(ctx: Context, turn: String, b: JSONObject): JSONObject {
        val screen = Screen.screenState(settle = false)
        val task = FutureTask<Boolean> {
            synchronized(state) {
                val id = b.optString("decision_id") + ":return"
                if (!state.mayReturn(id, turn) || AppState.homeVisible ||
                    epoch(screen) != b.optLong("expected_state_epoch", -1) || foreground(ctx, screen) != b.optString("expected_package") || foreground(ctx, screen).isBlank()) {
                    android.util.Log.d("ash.screen", "return rejected by current screen/turn fence")
                    false
                } else {
                    ctx.startActivity(Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                    state.applied(id)
                    true
                }
            }
        }
        main.post(task)
        val acted = try { task.get(1500, TimeUnit.MILLISECONDS) } catch (e: Throwable) {
            android.util.Log.d("ash.screen", "return not acknowledged: ${e.javaClass.simpleName}")
            task.cancel(false); false
        }
        return JSONObject().put("acted", acted)
    }

}
