package ai.ash.host.apps

import ai.ash.apps.Replies
import ai.ash.human.HumanSend
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException

/**
 * Ash's side of the apps shell's bridge (`IAppsBridge`): one word as the owner on the app's one connection, the kernel's
 * answer (a `Reply`) handed back as it is. The shell is the app's own other process, so a caller of any other uid is refused;
 * and only what [AppsBridgePolicy] lets through is sent. Every call blocks (up to the kernel's wait): never on the main thread.
 */
internal class AppsBridge(
    private val app: String?,
    private val myUid: Int,
    private val callingUid: () -> Int,
    /** Sends a human-channel `send` request and gives the `send.result` frame; see [HumanSend.send]. */
    private val send: (JSONObject) -> JSONObject,
) {
    fun call(to: String?, word: String?, bodyJson: String?): String = reply(to, word, bodyJson).toString()

    private fun reply(to: String?, word: String?, bodyJson: String?): JSONObject {
        if (callingUid() != myUid) return Replies.error("forbidden", "只有 Ash 自己的应用可以用")
        if (to == null || word == null || bodyJson == null) return Replies.error("bad_request", "请求不完整")
        if (bodyJson.length > MAX_BODY) return Replies.error("too_large", "请求太大")
        val body = try { JSONObject(bodyJson.ifBlank { "{}" }) } catch (_: JSONException) { return Replies.error("bad_request", "请求内容看不懂") }
        if (!AppsBridgePolicy.allows(app, to, word, body)) return Replies.error("forbidden", "这里不能这样调用")
        return try {
            val sent = send(JSONObject().put("to", to).put("kind", "request").put("word", word).put("body", body).put("wait", true))
            HumanSend.reply(sent) ?: Replies.error("result_unknown", "Ash 没有及时回复，结果不确定")
        } catch (e: HumanSend.Refused) {
            Replies.error(e.code, e.message.orEmpty().ifBlank { "Ash 没有收下" })
        } catch (_: IOException) {
            Replies.error("offline", "连不上 Ash：打开 Ash 后再试")
        } catch (_: Exception) {
            Replies.error("internal", "出了点问题")
        }
    }

    companion object {
        /** Characters: the request crosses Binder as a string, which is capped at about 1 MB shared by the process's transactions. */
        const val MAX_BODY = 256 * 1024
    }
}
