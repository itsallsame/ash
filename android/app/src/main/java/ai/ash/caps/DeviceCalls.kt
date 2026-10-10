package ai.ash.caps

import ai.ash.caps.decision.Decision
import ai.ash.caps.senses.SenseSync
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
class DeviceCalls(private val ctx: Context) : HandHandlers {
    override fun call(call: CallRequest, ctx: CallContext): CallOutcome =
        outcomeOf(Decision.call(this.ctx, call.capability, call.args, call.turn.orEmpty()))

    /** The kernel is there (again): sense batches it never acknowledged are offered once more. */
    override fun welcome(welcome: JSONObject) { SenseSync.pull() }

    override fun assess(capability: String, args: JSONObject): Assessment = assessmentFor(capability)

    override fun log(message: String, error: Throwable?) { android.util.Log.w("ash.link", message, error) }

    companion object {
        /** The phone's risks are fixed per capability (its declaration); a capability it does not know is the riskiest. */
        fun assessmentFor(capability: String): Assessment {
            val declared = Capabilities.byName[capability] ?: return Assessment("structure", "unknown capability")
            return Assessment(declared.risk)
        }

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
