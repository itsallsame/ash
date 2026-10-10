package ai.ash.caps.decision

import ai.ash.caps.CapResult
import ai.ash.caps.Capability
import ai.ash.caps.Caller
import ai.ash.caps.Effect
import ai.ash.caps.Risk
import ai.ash.caps.prop
import ai.ash.caps.result
import ai.ash.caps.schema
import android.content.Context
import org.json.JSONObject

/**
 * The words of the decision service: only the kernel may call them, never an agent (they were routes of the old host
 * bridge). They tell the kernel's reflex whether Ash is in front and which screen state is current, and carry out its
 * decision to come back or to close the virtual screen when nothing changed since it looked. Some of them depend on the
 * agent turn the call was made in, which the link hands over with the call.
 */
object DecisionCapabilities {
    private class DecisionCap(
        override val name: String,
        override val description: String,
        override val schema: JSONObject = schema(),
        override val effect: String,
        override val label: String,
        override val result: JSONObject,
        private val body: (Context, JSONObject, String) -> CapResult,
    ) : Capability {
        override val risk: String = Risk.NONE
        override val callers: List<String> = listOf(Caller.KERNEL)
        override fun run(ctx: Context, args: JSONObject): CapResult = body(ctx, args, "")
        override fun run(ctx: Context, args: JSONObject, turn: String): CapResult = body(ctx, args, turn)
    }

    val list: List<Capability> = listOf(
        DecisionCap("decision.surface", "Whether the hand app's home page is visible and live, with an epoch that changes when visibility changes. For the hub's reflex only.",
            effect = Effect.READ, label = "在看界面是否在前台",
            result = result("home_visible:boolean!", "page_live:boolean!", "visibility_epoch:integer!", "virtual_available:boolean")) { _, _, turn ->
            CapResult.json(Decision.surface(turn))
        },
        DecisionCap("decision.screen", "The foreground app and a state epoch, and whether a virtual screen is open and which turn owns it. For the hub's reflex only.",
            effect = Effect.READ, label = "在看前台应用",
            result = result("foreground_package:string!", "state_epoch:integer!", "virtual_generation:integer!", "virtual_owner_turn:string!", "virtual_open:boolean!")) { ctx, _, _ ->
            CapResult.json(Decision.snapshot(ctx))
        },
        DecisionCap("decision.return", "Return to the app that was in front, when the state epoch still matches. For the hub's reflex only.",
            schema(
                "expected_package" to prop("string", "The app that was in front when the decision looked.", required = true),
                "expected_state_epoch" to prop("integer", "The state epoch the decision saw.", required = true),
                "decision_id" to prop("string", "The decision, so that it acts once.", required = true),
            ),
            effect = Effect.ACT, label = "在回到原来的应用", result = result("acted:boolean!")) { ctx, args, turn ->
            CapResult.json(Decision.returnToAsh(ctx, turn, args))
        },
        DecisionCap("decision.virtual_close", "Close the virtual screen when it still belongs to the given turn and generation. For the hub's reflex only.",
            schema(
                "expected_generation" to prop("integer", "The virtual screen's generation the decision saw.", required = true),
                "owner_turn" to prop("string", "The turn that owns the virtual screen.", required = true),
                "decision_id" to prop("string", "The decision, so that it acts once.", required = true),
            ),
            effect = Effect.ACT, label = "在关闭后台屏幕", result = result("acted:boolean!")) { ctx, args, _ ->
            CapResult.json(Decision.closeVirtual(ctx, args))
        },
    )
}
