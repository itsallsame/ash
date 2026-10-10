package ai.ash.apps

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RepliesTest {
    private fun success(data: JSONObject? = null, content: JSONArray? = null): JSONObject {
        val result = JSONObject()
        if (data != null) result.put("data", data)
        if (content != null) result.put("content", content)
        return JSONObject().put("ok", true).put("result", result)
    }

    @Test fun aSuccessIsContentAndStructuredContent() {
        val data = JSONObject().put("text", "你好")
        val r = Replies.toolResult(success(data))
        assertFalse(r.has("isError"))
        assertEquals("你好", r.getJSONObject("structuredContent").getString("text"))
        val block = r.getJSONArray("content").getJSONObject(0)
        assertEquals("text", block.getString("type"))
        assertEquals(data.toString(), block.getString("text"))
    }

    @Test fun theRepliesOwnContentIsKept() {
        val content = JSONArray().put(JSONObject().put("type", "text").put("text", "记好了"))
        val r = Replies.toolResult(success(JSONObject().put("id", 1), content))
        assertEquals("记好了", r.getJSONArray("content").getJSONObject(0).getString("text"))
        assertEquals(1, r.getJSONObject("structuredContent").getInt("id"))
    }

    @Test fun aSuccessWithoutDataHasNoStructuredContent() {
        val r = Replies.toolResult(success())
        assertFalse(r.has("structuredContent"))
        assertEquals(0, r.getJSONArray("content").length())
    }

    @Test fun aFailureIsErrorWithTheReasonAndTheErrorBody() {
        val error = JSONObject().put("code", "failed").put("message", "disk full").put("recovery_hint", "free some space")
        val r = Replies.toolResult(JSONObject().put("ok", false).put("error", error))
        assertTrue(r.getBoolean("isError"))
        assertEquals("disk full", r.getJSONArray("content").getJSONObject(0).getString("text"))
        assertEquals("failed", r.getJSONObject("structuredContent").getJSONObject("error").getString("code"))
        assertEquals("free some space", r.getJSONObject("structuredContent").getJSONObject("error").getString("recovery_hint"))
    }

    @Test fun theOwnersLineWinsOverTheMessage() {
        val error = JSONObject().put("code", "forbidden").put("message", "not granted").put("owner_text", "安装时没有批准这一项，用不了")
        val r = Replies.toolResult(JSONObject().put("ok", false).put("error", error))
        assertEquals("安装时没有批准这一项，用不了", r.getJSONArray("content").getJSONObject(0).getString("text"))
    }

    @Test fun aReplyWithoutAnErrorBodyStillFailsCleanly() {
        val r = Replies.toolResult(JSONObject().put("ok", false))
        assertTrue(r.getBoolean("isError"))
        assertEquals("internal", r.getJSONObject("structuredContent").getJSONObject("error").getString("code"))
    }

    @Test fun surfaceUsesTheCspTheKernelGave() {
        val data = JSONObject().put("id", "health").put("surface", "home").put("mime", "text/html").put("html", "<p>hi</p>")
            .put("csp", JSONObject().put("connectDomains", JSONArray().put("https://api.example.com")).put("resourceDomains", JSONArray().put("https://cdn.example.com")))
        val page = Surface.parse(data)!!
        assertEquals("<p>hi</p>", page.html)
        assertEquals(listOf("https://api.example.com"), page.csp.connect)
        assertEquals(listOf("https://cdn.example.com"), page.csp.resource)
        assertTrue(page.csp.header().contains("connect-src https://api.example.com;"))
        assertTrue(page.csp.allows("https://api.example.com/v1"))
        assertFalse(page.csp.allows("https://evil.example.org/"))
    }

    @Test fun aPageWithoutCspGetsNoNetworkAndAPageWithoutHtmlIsNone() {
        val page = Surface.parse(JSONObject().put("html", "<p>hi</p>"))!!
        assertTrue(page.csp.connect.isEmpty() && page.csp.resource.isEmpty())
        assertTrue(page.csp.header().contains("connect-src 'none'"))
        assertEquals(null, Surface.parse(JSONObject().put("html", " ")))
    }
}
