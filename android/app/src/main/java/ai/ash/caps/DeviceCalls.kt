package ai.ash.caps

import ai.ash.caps.decision.ScreenDecisionHost
import ai.ash.caps.CapResult
import ai.ash.caps.CapabilityPolicies
import ai.ash.host.screen.ScreenBridge
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import ai.ash.link.Assessment
import ai.ash.link.CallContext
import ai.ash.link.CallOutcome
import ai.ash.link.CallRequest
import ai.ash.link.HandHandlers
import ai.ash.link.Part

/**
 * The device channel's calls: what the kernel asks of the phone, run through the capability registry. [call] and
 * [assess] run on the link's worker threads, so a capability that waits on the main thread (the island's touch
 * passthrough waits for it up to a second) never blocks it.
 */
class DeviceCalls(ctx: Context) : HandHandlers {
    private val decisions = ScreenDecisionHost(ctx)

    override fun call(call: CallRequest, ctx: CallContext): CallOutcome = outcomeOf(run(call))

    private fun run(call: CallRequest): CapResult {
        val args = call.args
        if (call.capability.startsWith("decision.")) return decide(call.capability, args)
        val run = { decisions.call(call.capability, args, call.turn.orEmpty()) }
        // Ash's own input to other apps passes under the island, and is refused while the owner is typing.
        return if (call.capability in TOUCH_PASSTHROUGH) {
            try { ScreenBridge.withTouchPassthrough(run) } catch (e: IllegalStateException) { CapResult.fail(e.message ?: "owner_input_busy") }
        } else run()
    }

    private fun decide(name: String, args: JSONObject): CapResult = when (name) {
        "decision.surface" -> CapResult.json(decisions.surface(args))
        "decision.screen" -> CapResult.json(decisions.snapshot())
        "decision.return" -> CapResult.json(decisions.returnToAsh(args))
        "decision.virtual_close" -> CapResult.json(decisions.closeVirtual(args))
        else -> CapResult.fail("the phone has no capability $name")
    }

    override fun assess(capability: String, args: JSONObject): Assessment = assessmentFor(capability)

    override fun log(message: String, error: Throwable?) { android.util.Log.w("ash.link", message, error) }

    companion object {
        /** The phone's risks are fixed per capability (Ash's policy); a capability it does not know is the riskiest. */
        fun assessmentFor(capability: String): Assessment {
            val policy = CapabilityPolicies.byName[capability]
                ?: return if (capability.startsWith("decision.")) Assessment("none") else Assessment("structure", "unknown capability")
            return Assessment(policy.risk)
        }

        /** Ash's own input to other apps passes under the island. */
        private val TOUCH_PASSTHROUGH = setOf("apps.open", "settings.open", "intent.view", "input.key")

        /** Failures a capability reports as plain text, and the unified error code (SPEC-02 §7) each one is. */
        private val CODES = setOf("cancelled", "timeout", "unavailable", "not_found", "forbidden", "bad_request", "failed")

        fun outcomeOf(result: CapResult): CallOutcome {
            val json = result.toJson()
            if (json.optBoolean("ok")) return CallOutcome.Ok(parts(json.optJSONArray("content") ?: JSONArray()), json.opt("data"))
            val message = json.optString("error").ifEmpty { "the call failed" }
            val data = json.opt("data") as? JSONObject
            val given = data?.optString("code").orEmpty()
            val code = when {
                given in CODES -> given
                message.startsWith("the phone has no capability") -> "not_found"
                message.contains("is not available right now") || message.startsWith("owner_input_busy") -> "unavailable"
                else -> "failed"
            }
            // A code of the capability's own (e.g. permission_denied) is kept for whoever wants it.
            return CallOutcome.Err(code, message, if (given.isNotEmpty() && given !in CODES) JSONObject().put("code", given) else null)
        }

        private fun parts(content: JSONArray): List<Part> = (0 until content.length()).map { i ->
            val c = content.getJSONObject(i)
            when (c.optString("type")) {
                "text" -> Part.Text(c.optString("text"))
                "image" -> Part.Image(c.optString("mimeType", "image/png"), c.optString("data"))
                else -> Part.Text(c.toString())
            }
        }
    }
}
