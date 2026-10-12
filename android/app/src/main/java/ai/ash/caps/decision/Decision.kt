package ai.ash.caps.decision

import ai.ash.caps.CapResult
import ai.ash.caps.Capabilities
import ai.ash.caps.screen.Screen
import ai.ash.caps.hostshell.HostShell
import ai.ash.caps.vscreen.VScreenClient
import ai.ash.host.AppState
import ai.ash.ui.HomeActivity
import ai.ash.ui.VScreenPreview
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/**
 * What the kernel's reflex asks of the phone to decide whether to bring Ash back or close the virtual screen
 * (`decision.*`, see [DecisionCapabilities]), and the bookkeeping behind it: which screen state a decision saw, and who
 * owns the virtual screen. Every other capability call passes through [call] so that bookkeeping sees it.
 */
object Decision {
    private val state = ScreenDecisionState()
    private val main = Handler(Looper.getMainLooper())

    @Synchronized fun surface(turn: String): JSONObject {
        state.beginTurn(turn)
        return JSONObject().put("home_visible", AppState.homeVisible).put("page_live", AppState.homePageLive)
            .put("visibility_epoch", AppState.visibilityEpoch.get())
            .put("virtual_available", Build.VERSION.SDK_INT >= 29 && HostShell.ready())
    }

    /** Screen changes, as the accessibility service counts them, with Ash's own turns and visibility. */
    private fun epoch(screen: JSONObject): Long = state.epoch + screen.optLong("epoch") + AppState.visibilityEpoch.get()
    private fun foreground(ctx: Context, screen: JSONObject): String = if (AppState.homeVisible) ctx.packageName else screen.optString("foreground_package")

    fun snapshot(ctx: Context): JSONObject {
        // App transitions can still be settling after apps.open's acknowledgment.
        val screen = Screen.screenState(settle = true)
        return synchronized(state) {
            JSONObject().put("foreground_package", foreground(ctx, screen)).put("state_epoch", epoch(screen))
                .put("virtual_generation", state.virtualGeneration).put("virtual_owner_turn", state.virtualOwner)
                .put("virtual_open", state.virtualOpen && VScreenClient.running())
        }
    }

    /** Runs capability [capability] for the kernel's call, keeping the decision state in step with what it did to the screens. */
    fun call(ctx: Context, capability: String, args: JSONObject, turn: String): CapResult {
        if (capability.startsWith("screen.") || capability in SCREEN_CHANGERS) state.screenChanged()
        if (!capability.startsWith("vscreen.")) return Capabilities.call(ctx, capability, args, turn)
        // Virtual calls and cleanup are serialized so a newer display can never be closed by an old decision.
        return synchronized(this) { virtualCall(ctx, capability, args, turn) }
    }

    /** Capabilities that change what is on the owner's screen without being `screen.*`. */
    private val SCREEN_CHANGERS = setOf("apps.open", "apps.open_url", "settings.open", "input.key", "x.android.browser.show")

    private fun virtualCall(ctx: Context, capability: String, args: JSONObject, turn: String): CapResult {
        val result = Capabilities.call(ctx, capability, args, turn)
        if (result.toJson().optBoolean("ok")) {
            when (capability) {
                "vscreen.create" -> state.virtualCreated(turn, result.toJson().optJSONObject("data")?.optBoolean("reused") ?: false)
                "vscreen.close" -> state.virtualClosed()
                "vscreen.status", "vscreen.see" -> Unit
                else -> state.virtualUsed(turn)
            }
        }
        return result
    }

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

    @Synchronized fun closeVirtual(ctx: Context, b: JSONObject): JSONObject {
        val id = b.optString("decision_id") + ":close"
        if (!state.mayClose(id, b.optString("owner_turn"), b.optLong("expected_generation", -1))) return JSONObject().put("acted", false)
        // Claim before dispatch: an uncertain reply must not repeat destruction of a later display.
        state.applied(id)
        VScreenPreview.hide()
        val result = VScreenClient.call(ctx, "close", timeoutMs = 8000, start = false)
        VScreenClient.stop()
        state.virtualClosed()
        return JSONObject().put("acted", result.optBoolean("ok"))
    }
}
