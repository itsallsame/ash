package ai.ash.human

import ai.ash.link.HandHandlers
import ai.ash.link.PresentOutcome
import org.json.JSONObject

/** Shows one surface of the human channel: [present] gets the `op` and `body` of a `present` frame (already checked against the protocol). */
fun interface SurfaceHandler {
    /** Runs on a worker thread, never the main thread. */
    fun present(op: String, body: JSONObject): PresentOutcome
}

/**
 * The human channel of the hand app (SPEC-03 §5): what the kernel shows to the owner on this phone. A `present` goes to
 * the handler of its surface, and only the surfaces this phone declares in `hello` ([surfaces]) are shown; for any other
 * the answer is none, which the link turns into `present.result` `unavailable`. What the owner says goes the other way,
 * as `send` (see [HumanSend] and [ChatBridge]); where the owner is, as `presence` (see [Presence]).
 */
class HumanChannel(private val handlers: Map<String, SurfaceHandler>) {
    /** The surfaces to declare in `hello`, in the order of the protocol. */
    val surfaces: List<String> = SURFACES.filter { it in handlers }

    /** The outcome of the `present` frame [frame], or null when this phone does not show that surface. */
    fun present(frame: JSONObject): PresentOutcome? =
        handlers[frame.getString("surface")]?.present(frame.getString("op"), frame.getJSONObject("body"))

    companion object {
        val SURFACES = listOf("chat", "notification", "island", "widget", "status")
    }
}

/**
 * The device handlers of the link plus the human channel: calls and assessments go where they went, `present` frames go to the
 * [HumanChannel], and [onChannel] hears when the human channel opens or closes (to tell the chat page, say what to send again).
 */
class HumanHandlers(
    private val base: HandHandlers,
    private val human: HumanChannel,
    private val onChannel: (open: Boolean, welcome: JSONObject?) -> Unit,
) : HandHandlers by base {
    override fun present(frame: JSONObject): PresentOutcome? = human.present(frame)

    override fun welcome(welcome: JSONObject) {
        base.welcome(welcome)
        onChannel(welcome.optJSONObject("channels")?.optJSONObject("human")?.has("client") == true, welcome)
    }

    override fun closed(info: ai.ash.link.CloseInfo) {
        base.closed(info)
        onChannel(false, null)
    }
}
