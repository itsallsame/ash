package ai.ash.link

import org.json.JSONObject
import java.io.IOException

/**
 * Where the person's words leave the phone: a notification reply, a button on the island or on a card, the stop button.
 * They are `send` frames of the human channel ([LinkClient.send]).
 *
 * TODO(T11b-2): the human channel (notifications, island, task status, home-screen cards, the chat page) is the next
 * task. Until it is wired, these actions are not sent: every call fails with [Unavailable], and the callers show their
 * existing "not confirmed, try again" states. There is no HTTP path to fall back on.
 */
internal object HumanSend {
    class Unavailable : IOException("the human channel is not wired yet (T11b-2)")

    /** `{to, kind, word, body, reply_to?, client_id?, wait?}` as in SPEC-02 §8; always throws until T11b-2. */
    fun send(@Suppress("UNUSED_PARAMETER") request: JSONObject): JSONObject = throw Unavailable()
}
