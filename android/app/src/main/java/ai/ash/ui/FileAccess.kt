package ai.ash.ui

import android.util.Base64
import org.json.JSONObject

/**
 * The files of a body and the originals of a message, read through [HumanPort] the way the web page's body.js and
 * inline-attachment.js did: `workspace.*` words on the body (`body:main/workspace.read`), `service:history` for a message,
 * `service:blobs` for a long attachment. All answers arrive on the main thread.
 */
class FileAccess(private val port: HumanPort) {
    /** A body (a device whose files can be read). */
    data class Body(val id: String, val name: String)
    data class Entry(val name: String, val directory: Boolean, val size: Long?)
    data class Listing(val path: String, val entries: List<Entry>, val truncated: Boolean)
    class Bytes(val data: ByteArray, val mime: String?)
    class Inline(val name: String, val mime: String, val b64: String)

    /** A word whose whole `result` (its `data` and its `content` parts) the caller wants. */
    private fun call(to: String, word: String, body: JSONObject, done: (JSONObject?, HumanPort.Failure?) -> Unit) =
        port.send(JSONObject().put("to", to).put("kind", "request").put("word", word).put("body", body).put("wait", true)) { r ->
            val reply = r.optJSONObject("response")
            when {
                !r.optBoolean("ok") -> done(null, failure(r.optJSONObject("error")))
                reply == null -> done(null, HumanPort.Failure("result_unknown", "还没有收到结果"))
                reply.optBoolean("ok") -> done(reply.optJSONObject("result") ?: JSONObject(), null)
                else -> done(null, failure(reply.optJSONObject("error")))
            }
        }

    private fun failure(e: JSONObject?) = HumanPort.Failure(e?.optString("code").orEmpty().ifEmpty { "failed" }, e?.optString("message").orEmpty().ifEmpty { "没有成功" })

    /** The bodies the hub has, the main one first. */
    fun bodies(done: (List<Body>?, HumanPort.Failure?) -> Unit) = port.call("service:bodies", "list") { data, f ->
        if (data == null) return@call done(null, f)
        val rows = data.optJSONArray("bodies")
        val list = (0 until (rows?.length() ?: 0)).mapNotNull { rows?.optJSONObject(it) }.map { it.optString("body") to it }.filter { it.first.isNotEmpty() }
            .map { (id, row) -> Body(id, row.optString("name").ifEmpty { id }) }
        done(list.sortedBy { if (it.id == MAIN) 0 else 1 }, null)
    }

    /** The entries of a directory of a body. */
    fun list(body: String, path: String, done: (Listing?, HumanPort.Failure?) -> Unit) =
        port.call(body, "workspace.ls", JSONObject().apply { if (path.isNotEmpty()) put("path", path) }) { data, f ->
            if (data == null) return@call done(null, f)
            val rows = data.optJSONArray("entries")
            val entries = (0 until (rows?.length() ?: 0)).mapNotNull { rows?.optJSONObject(it) }.filter { it.optString("name").isNotEmpty() }
                .map { Entry(it.optString("name"), it.optString("type") == "directory", if (it.has("size") && !it.isNull("size")) it.optLong("size") else null) }
            done(Listing(data.optString("path").ifEmpty { path }, entries, data.optBoolean("truncated")), null)
        }

    /** The bytes and type of a file: text as it is, an image from its part, a large or binary file from its stream. */
    fun read(body: String, path: String, done: (Bytes?, HumanPort.Failure?) -> Unit) =
        call(body, "workspace.read", JSONObject().put("path", path).put("limit", 100_000)) { result, f ->
            if (result == null) return@call done(null, f)
            val parts = result.optJSONArray("content")
            val list = (0 until (parts?.length() ?: 0)).mapNotNull { parts?.optJSONObject(it) }
            val resource = list.firstOrNull { it.optString("type") == "resource" }
            val image = list.firstOrNull { it.optString("type") == "image" }
            val text = result.optJSONObject("data")?.takeIf { it.has("text") }?.optString("text")
            when {
                resource != null -> port.stream(resource.optString("stream")) { mime, data, why ->
                    if (data != null) done(Bytes(data, mime?.ifEmpty { null } ?: resource.optString("mime").ifEmpty { null }), null) else done(null, why)
                }
                image != null -> {
                    val data = runCatching { Base64.decode(image.optString("b64"), Base64.DEFAULT) }.getOrNull()
                    if (data != null) done(Bytes(data, image.optString("mime").ifEmpty { null }), null) else done(null, HumanPort.Failure("failed", "文件无法读取"))
                }
                text != null -> done(Bytes(text.toByteArray(Charsets.UTF_8), "text/plain"), null)
                else -> done(null, HumanPort.Failure("failed", "文件无法读取"))
            }
        }

    /**
     * One inline attachment of a message, from the ledger's original record (the display copy of a message never carries its bytes):
     * only an owner↔agent `say`, and only the attachment [index] the window item named. A long one is a blob holding the base64 text.
     */
    fun inline(messageId: String, seq: Long, index: Int, done: (Inline?, HumanPort.Failure?) -> Unit) {
        val gone = HumanPort.Failure("failed", "附件无法打开")
        port.call("service:history", "read", JSONObject().put("from_seq", seq).put("to_seq", seq)) { data, f ->
            if (data == null) return@call done(null, f)
            val rows = data.optJSONArray("messages")
            val message = (0 until (rows?.length() ?: 0)).mapNotNull { rows?.optJSONObject(it) }.firstOrNull { it.optString("id") == messageId && it.optLong("seq") == seq }
            val from = message?.optString("from").orEmpty(); val to = message?.optString("to").orEmpty()
            val mine = from == "person:owner" && to.startsWith("agent:")
            val hers = to == "person:owner" && from.startsWith("agent:")
            if (message == null || message.optString("word") != "say" || message.optString("kind") != "request" || !(mine || hers)) return@call done(null, gone)
            val a = message.optJSONObject("body")?.optJSONArray("attachments")?.optJSONObject(index) ?: return@call done(null, gone)
            val name = a.optString("name"); val mime = a.optString("mime_type")
            if (name.isEmpty() || mime.isEmpty()) return@call done(null, gone)
            val raw = a.opt("data")
            val hash = (raw as? JSONObject)?.optString("\$blob").orEmpty()
            when {
                raw is String -> done(Inline(name, mime, raw), null)
                hash.isNotEmpty() -> port.call("service:blobs", "get", JSONObject().put("hash", hash)) { info, why ->
                    if (info == null) return@call done(null, why)
                    port.stream(info.optString("stream")) { _, bytes, why2 -> if (bytes != null) done(Inline(name, mime, String(bytes, Charsets.UTF_8)), null) else done(null, why2) }
                }
                else -> done(null, gone)
            }
        }
    }

    companion object { const val MAIN = "body:main" }
}
