package ai.ash.human

import ai.ash.link.LinkClient
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** The state of the human channel as the chat page is told it: kept by the bridge, so a page that is late or asks again gets it. */
class ChatBridgeStateTest {
    private class Page : ChatBridge.Page {
        val messages = CopyOnWriteArrayList<JSONObject>()
        override fun post(message: String) { messages.add(JSONObject(message)) }
        fun links() = messages.filter { it.optString("type") == "link" }
    }

    private val sent = ArrayList<JSONObject>()
    private val traces = ArrayList<String>()
    private val bridge = ChatBridge(
        object : ChatBridge.Uplink { override fun send(frame: JSONObject): LinkClient.Refusal? { sent.add(frame); return null } },
        object : ChatBridge.ChatUi { override fun bringToFront() = true },
        trace = { traces.add(it) },
    )

    @Test fun `a state told before any page is attached is given to the page when it attaches`() {
        bridge.linkChanged(true, "client:a", true)
        val page = Page()
        bridge.attach(page)
        assertEquals(1, page.links().size)
        val link = page.links().single()
        assertTrue(link.getBoolean("open")); assertEquals("client:a", link.getString("client")); assertTrue(link.getBoolean("local"))
    }

    @Test fun `before the channel ever opened a page is told it is closed`() {
        val page = Page()
        bridge.attach(page)
        assertFalse(page.links().single().getBoolean("open"))
    }

    @Test fun `only the last state is kept`() {
        bridge.linkChanged(true, "client:a")
        bridge.linkChanged(false)
        bridge.linkChanged(true, "client:b")
        val page = Page()
        bridge.attach(page)
        assertEquals("client:b", page.links().single().getString("client"))
    }

    @Test fun `a page that asks again is told the last state, and a closed one is told it is closed`() {
        val page = Page()
        bridge.attach(page)
        bridge.linkChanged(true, "client:a")
        page.messages.clear()
        assertTrue(bridge.resendLink())
        assertEquals("client:a", page.links().single().getString("client"))
        bridge.linkChanged(false)
        page.messages.clear()
        assertTrue(bridge.resendLink())
        assertFalse(page.links().single().getBoolean("open"))
        assertNull(page.links().single().opt("client"))
    }

    @Test fun `asking with no page attached says so and tells nobody`() {
        bridge.linkChanged(true, "client:a")
        assertFalse(bridge.resendLink())
    }

    @Test fun `a screen that is closing does not drop the page of the one that replaced it`() {
        val old = Page(); val fresh = Page()
        bridge.attach(old)
        bridge.attach(fresh)
        bridge.detach(old)
        bridge.linkChanged(true, "client:a")
        assertTrue(fresh.links().last().getBoolean("open"))
        bridge.detach(fresh)
        val after = Page()
        bridge.linkChanged(false)
        assertTrue(after.messages.isEmpty())
    }

    @Test fun `the log says when the page came, what it was told and how many frames passed`() {
        bridge.linkChanged(true, "client:a")
        bridge.attach(Page())
        bridge.fromKernel(JSONObject().put("t", "sync.msg"))
        assertTrue(traces.any { it.startsWith("page attached; link state told") && "client:a" in it })
        assertTrue(traces.any { it.startsWith("frames to the page: 1") })
    }
}
