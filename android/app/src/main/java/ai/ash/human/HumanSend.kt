package ai.ash.human

import ai.ash.link.Link
import ai.ash.link.LinkClient
import ai.ash.link.LinkException
import android.content.Context
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Where the person's words leave the phone: a notification reply or answer, a button on the island or on a card, the
 * stop button. They are `send` frames of the human channel (SPEC-03 §5.1). Every call blocks: never on the main thread.
 */
internal object HumanSend {
    /** The kernel refused the word; [code] is one of the unified error codes (SPEC-02 §7). */
    class Refused(val code: String, message: String) : IOException(message) {
        /** A refusal that asking again cannot change; anything else (no connection, a timeout, a kernel fault) may pass. */
        val final get() = code in FINAL
    }

    private val FINAL = setOf("bad_request", "unauthorized", "forbidden", "not_found", "denied", "cancelled", "conflict", "too_large")

    /**
     * `{to, kind, word, body, reply_to?, client_id?, wait?}` as in SPEC-02 §8. Returns the `send.result` frame once the
     * kernel took the message; throws [Refused] when it did not (or, with `wait`, when its answer did not come in time:
     * `result_unknown`, the word may have been done: it timed out, or the connection closed after it went out), or an
     * [IOException] when there was no answer (no connection; with no `wait`, also a connection lost or no acknowledgement in
     * time, which a retry with the same `client_id` settles, being counted once).
     */
    fun send(client: LinkClient, request: JSONObject): JSONObject {
        val waitsForResponse = request.optBoolean("wait")
        val frame = try {
            client.send(request).get(if (waitsForResponse) 70 else 15, TimeUnit.SECONDS)
        } catch (e: ExecutionException) {
            val cause = e.cause
            throw when {
                cause is LinkException && cause.kind == "bad_request" -> Refused("bad_request", cause.message.orEmpty())
                // It went out and the connection closed before the answer: the word may have been done.
                cause is LinkException && cause.kind == "lost" && waitsForResponse -> Refused("result_unknown", "the connection closed before the kernel answered")
                else -> IOException(cause?.message ?: "no connection")
            }
        } catch (_: TimeoutException) {
            // The frame went out (a closed link fails the future at once, as "closed"), so the word may well have been done: not "offline".
            throw if (waitsForResponse) Refused("result_unknown", "the kernel did not answer in time") else IOException("the kernel did not answer in time")
        }
        if (!frame.getBoolean("ok")) frame.getJSONObject("error").let { throw Refused(it.getString("code"), it.getString("message")) }
        return frame
    }

    fun send(ctx: Context, request: JSONObject): JSONObject = send(Link.get(ctx).client, request)

    /** The reply to a word sent with `wait`: the `response` of the `send.result`, `{ok, result?: {data?, content?}, error?}` (SPEC-01 §3); null when the kernel gave none in time. */
    fun reply(sent: JSONObject): JSONObject? = sent.optJSONObject("response")

    /** `result.data` of [reply], if the reply is a success. */
    fun data(sent: JSONObject): JSONObject? = reply(sent)?.takeIf { it.optBoolean("ok") }?.optJSONObject("result")?.optJSONObject("data")
}
