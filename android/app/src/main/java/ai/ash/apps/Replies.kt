package ai.ash.apps

import org.json.JSONArray
import org.json.JSONObject

/**
 * The kernel's answer to a word is a `Reply`: `{ok: true, result?: {data?, content?}} | {ok: false, error: {code, message, ...}}`
 * (SPEC-01 §3). The bridge hands it over as it is; this is what the apps shell makes of it.
 */
object Replies {
    fun error(code: String, message: String): JSONObject =
        JSONObject().put("ok", false).put("error", JSONObject().put("code", code).put("message", message))

    fun ok(data: JSONObject?): JSONObject {
        val result = JSONObject()
        if (data != null) result.put("data", data)
        return JSONObject().put("ok", true).put("result", result)
    }

    /** `result.data` of a success; null for a failure (or a success without data). */
    fun data(reply: JSONObject): JSONObject? = if (reply.optBoolean("ok")) reply.optJSONObject("result")?.optJSONObject("data") else null

    /** What to tell the owner about a failure: the kernel's line for the owner if it gave one, else its message. */
    fun errorText(reply: JSONObject): String {
        val e = reply.optJSONObject("error")
        return e?.optString("owner_text")?.takeIf { it.isNotBlank() } ?: e?.optString("message")?.takeIf { it.isNotBlank() } ?: "没办成"
    }

    /**
     * The MCP `CallToolResult` a page expects (T20 5): a success is `{content: result.content ?? [the data as JSON text],
     * structuredContent: data}`; a failure is `{isError: true, content: [the reason], structuredContent: {error}}`, the reason
     * being what the owner should read (the page shows `content[0].text`).
     */
    fun toolResult(reply: JSONObject): JSONObject {
        if (!reply.optBoolean("ok")) {
            val error = reply.optJSONObject("error") ?: JSONObject().put("code", "internal").put("message", "没办成")
            return JSONObject().put("isError", true)
                .put("content", JSONArray().put(JSONObject().put("type", "text").put("text", errorText(reply))))
                .put("structuredContent", JSONObject().put("error", error))
        }
        val result = reply.optJSONObject("result")
        val data = result?.optJSONObject("data")
        val content = result?.optJSONArray("content")
            ?: if (data != null) JSONArray().put(JSONObject().put("type", "text").put("text", data.toString())) else JSONArray()
        val out = JSONObject().put("content", content)
        if (data != null) out.put("structuredContent", data)
        return out
    }
}
