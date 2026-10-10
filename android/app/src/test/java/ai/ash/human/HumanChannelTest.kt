package ai.ash.human

import ai.ash.link.KernelConn
import ai.ash.link.LinkClient
import ai.ash.link.PresentOutcome
import ai.ash.link.TestLink
import ai.ash.link.awaitTrue
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** What a surface was asked, and what it answers. */
private class Surface(val name: String, var answer: (String, JSONObject) -> PresentOutcome = { _, _ -> PresentOutcome(true) }) : SurfaceHandler {
    val asked = CopyOnWriteArrayList<Pair<String, JSONObject>>()
    val threads = CopyOnWriteArrayList<String>()
    override fun present(op: String, body: JSONObject): PresentOutcome {
        asked.add(op to body); threads.add(Thread.currentThread().name)
        return answer(op, body)
    }
}

/** A page that keeps what it is given. */
private class FakePage : ChatBridge.Page {
    val messages = CopyOnWriteArrayList<JSONObject>()
    override fun post(message: String) { messages.add(JSONObject(message)) }
    fun frames(type: String) = messages.filter { it.optString("type") == "frame" && it.getJSONObject("frame").optString("t") == type }.map { it.getJSONObject("frame") }
    fun links() = messages.filter { it.optString("type") == "link" }
}

private fun KernelConn.present(id: String, surface: String, op: String, body: JSONObject = JSONObject()) = send(
    JSONObject().put("t", "present").put("ch", "human").put("id", id).put("surface", surface).put("op", op).put("body", body),
)

private fun KernelConn.presentResult(id: String): JSONObject {
    awaitTrue("present.result $id") { framesOf("present.result").any { it.getString("id") == id } }
    return framesOf("present.result").first { it.getString("id") == id }
}

/** The human channel on a fake kernel: opening it, what `present` reaches, what the owner's words and place look like on the wire. */
class HumanChannelTest {
    private val surfaces = linkedMapOf(
        "chat" to Surface("chat"), "notification" to Surface("notification"), "island" to Surface("island"),
        "widget" to Surface("widget"), "status" to Surface("status"),
    )
    private val page = FakePage()
    private lateinit var channelEvents: CopyOnWriteArrayList<Boolean>
    private lateinit var bridge: ChatBridge
    private var focused = true
    private lateinit var presence: Presence
    private lateinit var link: TestLink
    private var visible = true

    private fun start(declared: Map<String, SurfaceHandler> = surfaces, human: Boolean = true): KernelConn {
        val channel = HumanChannel(declared)
        channelEvents = CopyOnWriteArrayList()
        var client: LinkClient? = null
        link = TestLink(
            wrap = { base ->
                HumanHandlers(base, channel) { open, welcome ->
                    channelEvents.add(open)
                    val grant = welcome?.optJSONObject("channels")?.optJSONObject("human")
                    bridge.linkChanged(open, grant?.optString("client"), grant?.optBoolean("local") ?: false)
                    if (open) presence.tell()
                }
            },
            surfaces = channel.surfaces,
            humanFrames = { bridge.fromKernel(it) },
        )
        client = link.client
        bridge = ChatBridge(ChatBridge.LinkUplink { client!! }, object : ChatBridge.ChatUi { override fun bringToFront() = focused })
        presence = Presence(client) { visible }
        return link.connect(human = human)
    }

    @After fun end() { if (::link.isInitialized) link.close() }

    // --- opening the channel ---

    @Test fun theHelloAsksForTheHumanChannelWithTheSurfacesThePhoneShows() {
        val conn = start()
        val hello = conn.awaitFrame("hello")
        val human = hello.getJSONObject("channels").getJSONObject("human")
        assertEquals("Test phone chat", human.getString("label"))
        assertEquals(listOf("chat", "notification", "island", "widget", "status"), (0 until human.getJSONArray("surfaces").length()).map { human.getJSONArray("surfaces").getString(it) })
        assertTrue(link.client.channelOpen("human"))
        awaitTrue("the handler heard the channel open") { channelEvents.toList() == listOf(true) }
    }

    @Test fun aKernelThatRefusesTheHumanChannelLeavesItClosed() {
        val conn = start(human = false)
        assertFalse(link.client.channelOpen("human"))
        awaitTrue("the handler heard it stay closed") { channelEvents.toList() == listOf(false) }
        // Nothing can be sent up the channel.
        link.client.presence(JSONObject().put("visible", true))
        assertEquals("offline", link.client.sendHumanFrame(sendFrame("s1"))!!.code)
        Thread.sleep(100)
        assertTrue(conn.framesOf("presence").isEmpty())
    }

    // --- present ---

    @Test fun eachSurfaceIsHandedToItsOwnHandlerOnAWorkerAndAnsweredWithItsResult() {
        val conn = start()
        surfaces.getValue("notification").answer = { _, _ -> PresentOutcome(true, JSONObject().put("shown", true)) }
        surfaces.getValue("island").answer = { _, _ -> PresentOutcome(true, JSONObject().put("showing", true)) }
        conn.present("p1", "notification", "show", JSONObject().put("id", "n1").put("kind", "reply").put("title", "Ash").put("text", "hi"))
        conn.present("p2", "island", "query")
        conn.present("p3", "status", "frame", JSONObject().put("turn", "t_1").put("state", "working"))
        conn.present("p4", "widget", "state", JSONObject().put("revision", 2))
        conn.present("p5", "notification", "hide", JSONObject().put("id", "n1"))
        conn.present("p6", "notification", "alert", JSONObject().put("id", "n1"))

        val r1 = conn.presentResult("p1")
        assertTrue(r1.getBoolean("ok")); assertTrue(r1.getJSONObject("data").getBoolean("shown"))
        assertTrue(conn.presentResult("p2").getJSONObject("data").getBoolean("showing"))
        for (id in listOf("p3", "p4", "p5", "p6")) assertTrue(conn.presentResult(id).getBoolean("ok"))

        val notification = surfaces.getValue("notification")
        assertEquals(listOf("show", "hide", "alert"), notification.asked.map { it.first })
        assertEquals("n1", notification.asked[0].second.getString("id"))
        assertEquals("working", surfaces.getValue("status").asked.single().second.getString("state"))
        assertEquals(2, surfaces.getValue("widget").asked.single().second.getInt("revision"))
        assertEquals("query", surfaces.getValue("island").asked.single().first)
        assertTrue("a present never runs on the link's own thread", surfaces.values.flatMap { it.threads }.all { it == "ash-link-call" })
        assertTrue(surfaces.getValue("chat").asked.isEmpty())
    }

    @Test fun aSurfaceThatRefusesAnswersWithItsErrorCode() {
        val conn = start()
        surfaces.getValue("notification").answer = { _, _ -> PresentOutcome(false, null, "conflict", "presentation_id_reused") }
        conn.present("p1", "notification", "show", JSONObject().put("id", "n1").put("kind", "reply").put("title", "").put("text", ""))
        val result = conn.presentResult("p1")
        assertFalse(result.getBoolean("ok"))
        assertEquals("conflict", result.getJSONObject("error").getString("code"))
        assertEquals("presentation_id_reused", result.getJSONObject("error").getString("message"))
    }

    @Test fun aHandlerThatThrowsAnswersFailed() {
        val conn = start()
        surfaces.getValue("island").answer = { _, _ -> throw IllegalStateException("no window") }
        conn.present("p1", "island", "query")
        val result = conn.presentResult("p1")
        assertEquals("failed", result.getJSONObject("error").getString("code"))
        assertEquals("no window", result.getJSONObject("error").getString("message"))
    }

    @Test fun aSurfaceThePhoneDidNotDeclareIsNotHandledAndAnsweredUnavailable() {
        val conn = start(declared = mapOf("notification" to surfaces.getValue("notification")))
        val hello = conn.awaitFrame("hello").getJSONObject("channels").getJSONObject("human").getJSONArray("surfaces")
        assertEquals(listOf("notification"), (0 until hello.length()).map { hello.getString(it) })
        conn.present("p1", "island", "query")
        conn.present("p2", "widget", "state")
        for (id in listOf("p1", "p2")) {
            val result = conn.presentResult(id)
            assertFalse(result.getBoolean("ok"))
            assertEquals("unavailable", result.getJSONObject("error").getString("code"))
        }
        assertTrue(surfaces.getValue("island").asked.isEmpty() && surfaces.getValue("widget").asked.isEmpty())
    }

    @Test fun aCardPresentAnswersWithWhatWasDrawnAndThePreviewPictures() {
        val conn = start()
        val rendered = JSONArray().put(JSONObject().put("card", "weather").put("updated_at", 7).put("preview", JSONObject().put("png", "AQID").put("width", 720).put("height", 385).put("theme", "dark")))
            .put(JSONObject().put("card", "todo").put("updated_at", 3).put("problem", "image failed"))
        val placed = JSONArray().put(JSONObject().put("id", "12").put("type", "card"))
        surfaces.getValue("widget").answer = { op, _ -> if (op == "state") PresentOutcome(true, ai.ash.widget.WidgetPlan.stateResult(placed, rendered)) else PresentOutcome(false) }
        conn.present("p1", "widget", "state", JSONObject().put("revision", 4).put("cards", JSONArray()))
        val data = conn.presentResult("p1").getJSONObject("data")
        assertEquals("12", data.getJSONArray("widgets").getJSONObject(0).getString("id"))
        assertEquals("AQID", data.getJSONArray("rendered").getJSONObject(0).getJSONObject("preview").getString("png"))
        assertEquals("image failed", data.getJSONArray("rendered").getJSONObject(1).getString("problem"))
        assertTrue(data.getBoolean("previews"))
    }

    @Test fun aWidgetPreviewAnswersWithOneImagePart() {
        val conn = start()
        surfaces.getValue("widget").answer = { op, body ->
            if (op == "preview") PresentOutcome(true, ai.ash.widget.PreviewPlan.imagePart(byteArrayOf(1, 2, 3), 720, 385, true, 363.2f, 192.6f) { "AQID:${body.getString("size")}" })
            else PresentOutcome(false)
        }
        conn.present("p1", "widget", "preview", JSONObject().put("card", "weather").put("size", "4x2"))
        val part = conn.presentResult("p1").getJSONObject("data")
        assertEquals("image", part.getString("type")); assertEquals("image/png", part.getString("mime")); assertEquals("AQID:4x2", part.getString("b64"))
        assertEquals("dark", part.getString("theme")); assertEquals(363, part.getJSONObject("dp").getInt("width"))
    }

    // --- the chat surface ---

    @Test fun aChatFocusBringsTheChatPageUp() {
        val conn = start()
        val handler = HumanChannel(mapOf("chat" to SurfaceHandler { op, body -> bridge.present(op, body) }))
        assertEquals(listOf("chat"), handler.surfaces)
        focused = true
        assertTrue(handler.present(JSONObject().put("id", "p1").put("surface", "chat").put("op", "focus").put("body", JSONObject()))!!.ok)
        focused = false
        val refused = handler.present(JSONObject().put("id", "p2").put("surface", "chat").put("op", "focus").put("body", JSONObject()))!!
        assertFalse(refused.ok); assertEquals("unavailable", refused.errorCode)
        assertTrue(conn.framesOf("present.result").isEmpty())
    }

    @Test fun aChatOpenGoesToThePageAndTheOutcomeIsThePagesAnswer() {
        start()
        bridge.attach(page)
        val outcome = java.util.concurrent.CompletableFuture.supplyAsync { bridge.present("open", JSONObject().put("target", "settings"), 5_000) }
        awaitTrue("the page got the present") { page.frames("present").isNotEmpty() }
        val given = page.frames("present").single()
        assertEquals("chat", given.getString("surface")); assertEquals("open", given.getString("op")); assertEquals("settings", given.getJSONObject("body").getString("target"))
        bridge.fromPage(JSONObject().put("t", "present.result").put("id", given.getString("id")).put("ok", true).put("data", JSONObject().put("opened", true)))
        val done = outcome.get(5, java.util.concurrent.TimeUnit.SECONDS)
        assertTrue(done.ok); assertTrue((done.data as JSONObject).getBoolean("opened"))
    }

    @Test fun aChatOpenWaitsForThePageThatIsStillStartingAndFailsWhenNoneComes() {
        start()
        val outcome = java.util.concurrent.CompletableFuture.supplyAsync { bridge.present("open", JSONObject().put("target", "approvals"), 5_000) }
        Thread.sleep(80) // the activity is starting: no page yet
        bridge.attach(page)
        awaitTrue("the waiting present reaches the page once it is there") { page.frames("present").isNotEmpty() }
        val id = page.frames("present").single().getString("id")
        bridge.fromPage(JSONObject().put("t", "present.result").put("id", id).put("ok", false).put("error", JSONObject().put("code", "not_found").put("message", "no such page")))
        val failed = outcome.get(5, java.util.concurrent.TimeUnit.SECONDS)
        assertFalse(failed.ok); assertEquals("not_found", failed.errorCode)

        val none = bridge.present("open", JSONObject().put("target", "memory"), 150).also { bridge.detach() }
        assertFalse(none.ok); assertTrue(none.errorCode == "timeout" || none.errorCode == "unavailable")
    }

    // --- send, sync, stream: the page's frames as they are ---

    private fun sendFrame(id: String, word: String = "say") = JSONObject().put("t", "send").put("ch", "human").put("id", id)
        .put("request", JSONObject().put("to", "agent:main").put("kind", "request").put("word", word).put("body", JSONObject().put("text", "hello")).put("client_id", "c-$id"))

    @Test fun aSendFromThePageGoesUpAsItIsAndItsResultComesBackToThePage() {
        val conn = start()
        bridge.attach(page)
        val frame = sendFrame("page-1")
        bridge.fromPage(frame)
        val up = conn.awaitFrame("send")
        assertEquals(frame.toString(), up.toString())
        conn.send(JSONObject().put("t", "send.result").put("id", "page-1").put("ok", true).put("message", JSONObject().put("id", "m1").put("seq", 9)))
        awaitTrue("send.result at the page") { page.frames("send.result").isNotEmpty() }
        val result = page.frames("send.result").single()
        assertEquals("page-1", result.getString("id")); assertEquals(9, result.getJSONObject("message").getInt("seq"))
    }

    @Test fun theNativeSendAndThePagesSendShareTheConnectionWithoutMixingTheirResults() {
        val conn = start()
        bridge.attach(page)
        val native = link.client.send(JSONObject().put("to", "service:reflex").put("kind", "request").put("word", "task.stop").put("body", JSONObject().put("turn", "t_1")).put("wait", true))
        bridge.fromPage(sendFrame("page-1"))
        awaitTrue("both sent") { conn.framesOf("send").size == 2 }
        val nativeId = conn.framesOf("send").first { it.getString("id") != "page-1" }.getString("id")
        conn.send(JSONObject().put("t", "send.result").put("id", nativeId).put("ok", true).put("message", JSONObject().put("id", "m2").put("seq", 1))
            .put("response", JSONObject().put("ok", true).put("result", JSONObject().put("data", JSONObject().put("cancelled", true)))))
        conn.send(JSONObject().put("t", "send.result").put("id", "page-1").put("ok", true).put("message", JSONObject().put("id", "m3").put("seq", 2)))
        val done = native.get(5, java.util.concurrent.TimeUnit.SECONDS)
        assertTrue(HumanSend.data(done)!!.getBoolean("cancelled"))
        awaitTrue("page result") { page.frames("send.result").isNotEmpty() }
        assertEquals(listOf("page-1"), page.frames("send.result").map { it.getString("id") })
    }

    @Test fun aSyncPagesComeToThePageInOrderAndPushedMessagesFollow() {
        val conn = start()
        bridge.attach(page)
        bridge.fromPage(JSONObject().put("t", "sync").put("ch", "human").put("sid", "y1").put("limit", 2).put("follow", true).put("summary", true))
        assertEquals(2, conn.awaitFrame("sync").getInt("limit"))
        fun page(n: Int, end: Boolean) = JSONObject().put("t", "sync.page").put("sid", "y1").put("end", end)
            .put("messages", JSONArray().put(JSONObject().put("seq", n * 2 - 1)).put(JSONObject().put("seq", n * 2)))
        conn.send(page(1, false)); conn.send(page(2, true))
        conn.send(JSONObject().put("t", "sync.msg").put("sid", "y1").put("message", JSONObject().put("seq", 5)))
        awaitTrue("two pages and a pushed message") { page.frames("sync.page").size == 2 && page.frames("sync.msg").size == 1 }
        assertEquals(listOf(false, true), page.frames("sync.page").map { it.getBoolean("end") })
        assertEquals(listOf(1, 2), page.frames("sync.page")[0].getJSONArray("messages").let { a -> (0 until a.length()).map { a.getJSONObject(it).getInt("seq") } })
        assertEquals(5, page.frames("sync.msg").single().getJSONObject("message").getInt("seq"))
        // A page can ask for earlier messages with another sync.
        bridge.fromPage(JSONObject().put("t", "sync").put("ch", "human").put("sid", "y2").put("before", 3).put("limit", 10))
        assertEquals(3, conn.awaitFrame("sync", 1).getInt("before"))
    }

    @Test fun whenThePageGoesItsSyncsAreClosed() {
        val conn = start()
        bridge.attach(page)
        bridge.fromPage(JSONObject().put("t", "sync").put("ch", "human").put("sid", "y1").put("follow", true))
        bridge.fromPage(JSONObject().put("t", "sync").put("ch", "human").put("sid", "y2"))
        bridge.fromPage(JSONObject().put("t", "sync.close").put("sid", "y2"))
        awaitTrue("sync frames up") { conn.framesOf("sync").size == 2 && conn.framesOf("sync.close").size == 1 }
        bridge.detach()
        awaitTrue("the page's remaining sync is closed") { conn.framesOf("sync.close").size == 2 }
        assertEquals(listOf("y2", "y1"), conn.framesOf("sync.close").map { it.getString("sid") })
        // And nothing more reaches a page that is gone.
        conn.send(JSONObject().put("t", "sync.msg").put("sid", "y1").put("message", JSONObject()))
        Thread.sleep(100)
        assertTrue(page.frames("sync.msg").isEmpty())
    }

    @Test fun aBlobTheKernelStreamsToTheHumanChannelReachesThePageButADeviceStreamIsRefused() {
        val conn = start()
        bridge.attach(page)
        conn.send(JSONObject().put("t", "stream").put("sid", "st1").put("op", "open").put("ch", "human").put("mime", "image/png").put("size", 3))
        conn.send(JSONObject().put("t", "stream").put("sid", "st1").put("op", "data").put("seq", 0).put("b64", "AQID"))
        conn.send(JSONObject().put("t", "stream").put("sid", "st1").put("op", "end"))
        awaitTrue("three stream frames at the page") { page.frames("stream").size == 3 }
        assertEquals(listOf("open", "data", "end"), page.frames("stream").map { it.getString("op") })
        // Data of a stream nobody was told about is not passed on.
        conn.send(JSONObject().put("t", "stream").put("sid", "other").put("op", "data").put("seq", 0).put("b64", "AQID"))
        // A stream for the device channel is still not taken.
        conn.send(JSONObject().put("t", "stream").put("sid", "st2").put("op", "open").put("ch", "device"))
        val refused = conn.awaitFrame("stream")
        assertEquals("st2", refused.getString("sid")); assertEquals("error", refused.getString("op")); assertEquals("unavailable", refused.getString("code"))
        assertEquals(3, page.frames("stream").size)
    }

    @Test fun thePageCanUploadAStreamOnTheHumanChannelOnly() {
        val conn = start()
        bridge.attach(page)
        bridge.fromPage(JSONObject().put("t", "stream").put("sid", "up1").put("op", "open").put("ch", "human").put("ref", "page-1"))
        bridge.fromPage(JSONObject().put("t", "stream").put("sid", "up1").put("op", "data").put("seq", 0).put("b64", "AQID"))
        bridge.fromPage(JSONObject().put("t", "stream").put("sid", "up1").put("op", "end"))
        awaitTrue("the upload went up") { conn.framesOf("stream").size == 3 }
        bridge.fromPage(JSONObject().put("t", "stream").put("sid", "up2").put("op", "open").put("ch", "device"))
        awaitTrue("a device stream is refused to the page") { page.frames("error").isNotEmpty() }
        assertEquals("up2", page.frames("error").single().getString("id"))
        assertEquals(3, conn.framesOf("stream").size)
    }

    @Test fun aFrameThePageCannotSendComesBackAsAnErrorWithItsId() {
        val conn = start()
        bridge.attach(page)
        // Breaks the protocol: no body.
        bridge.fromPage(JSONObject().put("t", "send").put("ch", "human").put("id", "bad-1").put("request", JSONObject().put("to", "agent:main").put("kind", "request").put("word", "say")))
        // Not a human channel frame.
        bridge.fromPage(JSONObject().put("t", "event").put("ch", "device").put("id", "e1").put("word", "sense.battery").put("body", JSONObject()).put("at", 1))
        awaitTrue("two errors at the page") { page.frames("error").size == 2 }
        assertEquals(listOf("bad-1", "e1"), page.frames("error").map { it.getString("id") })
        assertTrue(page.frames("error").all { it.getString("code") == "bad_request" })
        Thread.sleep(50)
        assertTrue(conn.framesOf("send").isEmpty() && conn.framesOf("event").isEmpty())
    }

    @Test fun aFrameTooBigForOneFrameComesBackTooLargeInsteadOfBeingLost() {
        val conn = start()
        bridge.attach(page)
        bridge.fromPage(sendFrame("big-1").also { it.getJSONObject("request").put("body", JSONObject().put("text", "x".repeat(ai.ash.link.LinkProtocol.FRAME_BYTES + 10))) })
        awaitTrue("too_large at the page") { page.frames("error").isNotEmpty() }
        assertEquals("big-1", page.frames("error").single().getString("id")); assertEquals("too_large", page.frames("error").single().getString("code"))
        Thread.sleep(50)
        assertTrue(conn.framesOf("send").isEmpty())
    }

    @Test fun whileTheConnectionIsDownTheSendComesBackOfflineAndThePageKnowsTheLink() {
        val conn = start()
        bridge.attach(page)
        assertEquals(true, page.links().last().getBoolean("open"))
        assertEquals("client:test", page.links().last().getString("client")); assertEquals(true, page.links().last().getBoolean("local"))
        conn.close(4500)
        awaitTrue("link closed at the page") { page.links().last().getBoolean("open").not() }
        bridge.fromPage(sendFrame("page-2"))
        awaitTrue("an offline error") { page.frames("error").isNotEmpty() }
        val error = page.frames("error").single()
        assertEquals("page-2", error.getString("id")); assertEquals("offline", error.getString("code"))
        // The reconnect opens it again.
        link.clock.awaitTimer(1000); link.clock.advance(1000)
        val again = link.kernel.awaitConn(1)
        again.awaitFrame("hello"); again.welcome()
        awaitTrue("link open again") { page.links().last().getBoolean("open") }
    }

    @Test fun aPageThatAttachesLateIsToldTheStateOfTheLinkAtOnce() {
        start()
        awaitTrue("channel open") { channelEvents.toList() == listOf(true) }
        bridge.attach(page)
        assertTrue(page.messages.first().getBoolean("open"))
        assertEquals("link", page.messages.first().getString("type"))
    }

    // --- presence ---

    @Test fun thePhoneTellsTheKernelWhereTheOwnerIsWhenTheChannelOpensAndWhenItChanges() {
        visible = true
        val conn = start()
        val first = conn.awaitFrame("presence")
        assertEquals("human", first.getString("ch")); assertTrue(first.getBoolean("visible"))
        visible = false
        presence.tell()
        awaitTrue("a second presence") { conn.framesOf("presence").size == 2 }
        assertFalse(conn.framesOf("presence")[1].getBoolean("visible"))
        // After a reconnect the new connection is told again.
        visible = true
        conn.close(4500)
        link.clock.awaitTimer(1000); link.clock.advance(1000)
        val again = link.kernel.awaitConn(1)
        again.awaitFrame("hello"); again.welcome()
        assertTrue(again.awaitFrame("presence").getBoolean("visible"))
    }

    @Test fun typingToAnAgentIsThePagesOwnPresenceFrameSentAsItIs() {
        val conn = start()
        bridge.attach(page)
        val typing = JSONObject().put("t", "presence").put("ch", "human").put("typing", true).put("agent", "agent:main")
        bridge.fromPage(typing)
        awaitTrue("typing up") { conn.framesOf("presence").any { it.has("typing") } }
        assertEquals(typing.toString(), conn.framesOf("presence").first { it.has("typing") }.toString())
        // An empty presence frame breaks the protocol.
        bridge.fromPage(JSONObject().put("t", "presence").put("ch", "human"))
        awaitTrue("refused") { page.frames("error").isNotEmpty() }
    }
}
