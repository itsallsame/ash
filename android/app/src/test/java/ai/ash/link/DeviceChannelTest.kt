package ai.ash.link

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** The device channel: manifest, calls (result, progress, cancel, the in-flight limit, streams), assess. */
class DeviceChannelTest {
    private val link = TestLink()
    @After fun end() = link.close()

    private fun results(conn: KernelConn) = conn.framesOf("result")

    @Test fun theManifestIsSentRightAfterTheHandshakeAndAgainAfterEveryReconnect() {
        link.client.setManifest(listOf(manifestCap("screen.tap"), manifestCap("clipboard.get")), listOf(JSONObject().put("word", "sense.battery").put("description", "d")))
        val conn = link.connect()
        val manifest = conn.awaitFrame("manifest")
        assertEquals("device", manifest.getString("ch"))
        assertEquals(1, manifest.getInt("rev"))
        assertEquals(listOf("screen.tap", "clipboard.get"), manifest.getJSONArray("capabilities").objects().map { it.getString("name") })
        assertEquals("sense.battery", manifest.getJSONArray("events").getJSONObject(0).getString("word"))
        conn.send(JSONObject().put("t", "manifest.ack").put("rev", 1).put("accepted", true).put("rejected", JSONArray()))
        awaitTrue("ack seen") { link.handlers.acks.size == 1 }

        conn.close(4500)
        link.clock.awaitTimer(1000); link.clock.advance(1000)
        val again = link.kernel.awaitConn(1)
        again.awaitFrame("hello"); again.welcome()
        assertEquals(1, again.awaitFrame("manifest").getInt("rev"))
    }

    @Test fun aChangedManifestIsSentAgainWithTheNextRev() {
        link.client.setManifest(listOf(manifestCap("screen.tap")), emptyList())
        val conn = link.connect()
        conn.awaitFrame("manifest")
        link.client.setManifest(listOf(manifestCap("screen.tap"), manifestCap("screen.read")), emptyList())
        val second = conn.awaitFrame("manifest", 1)
        assertEquals(2, second.getInt("rev"))
        assertEquals(2, second.getJSONArray("capabilities").length())
    }

    @Test fun noManifestIsSentWhenTheKernelRefusesTheDeviceChannel() {
        link.client.setManifest(listOf(manifestCap()), emptyList())
        val conn = link.connect(device = false)
        Thread.sleep(150)
        assertTrue(conn.framesOf("manifest").isEmpty())
    }

    @Test fun aCallIsRunAndAnsweredWithItsResult() {
        var seen: CallRequest? = null
        link.handlers.onCall = { call, _ -> seen = call; CallOutcome.Ok(listOf(Part.Text("tapped")), JSONObject().put("x", 1)) }
        val conn = link.connect()
        conn.call("c1", "screen.tap", JSONObject().put("x", 3).put("y", 4))
        val result = conn.awaitFrame("result")
        assertEquals("c1", result.getString("id"))
        assertTrue(result.getBoolean("ok"))
        assertEquals("tapped", result.getJSONArray("content").getJSONObject(0).getString("text"))
        assertEquals(1, result.getJSONObject("data").getInt("x"))
        assertEquals("screen.tap", seen!!.capability)
        assertEquals(3, seen!!.args.getInt("x"))
        assertEquals("t_1", seen!!.turn)
        assertEquals("agent:main", seen!!.member)
    }

    @Test fun aCallRunsOnAWorkerThreadNotOnTheLinksOwnThread() {
        val threads = java.util.concurrent.LinkedBlockingQueue<String>()
        link.handlers.onCall = { _, _ -> threads.add(Thread.currentThread().name); CallOutcome.Ok(listOf(Part.Text("x"))) }
        val conn = link.connect()
        conn.call("c1")
        conn.awaitFrame("result")
        assertEquals("ash-link-call", threads.poll(5, TimeUnit.SECONDS))
    }

    @Test fun aHandlerThatThrowsGivesAFailedResultAndTheErrorCodesPassThrough() {
        link.handlers.onCall = { call, _ ->
            when (call.id) {
                "c1" -> throw IllegalStateException("boom")
                else -> CallOutcome.Err("unavailable", "no accessibility", JSONObject().put("hint", "turn it on"))
            }
        }
        val conn = link.connect()
        conn.call("c1"); conn.call("c2")
        awaitTrue("two results") { results(conn).size == 2 }
        val byId = results(conn).associateBy { it.getString("id") }
        assertFalse(byId.getValue("c1").getBoolean("ok"))
        assertEquals("failed", byId.getValue("c1").getJSONObject("error").getString("code"))
        assertEquals("boom", byId.getValue("c1").getJSONObject("error").getString("message"))
        assertEquals("unavailable", byId.getValue("c2").getJSONObject("error").getString("code"))
        assertEquals("turn it on", byId.getValue("c2").getJSONObject("error").getJSONObject("detail").getString("hint"))
    }

    @Test fun progressComesBeforeTheResult() {
        link.handlers.onCall = { _, ctx -> ctx.progress("half way"); CallOutcome.Ok(listOf(Part.Text("done"))) }
        val conn = link.connect()
        conn.call("c1")
        conn.awaitFrame("result")
        assertEquals("half way", conn.awaitFrame("progress").getString("text"))
        val order = conn.frames.map { it.getString("t") }
        assertTrue(order.indexOf("progress") < order.indexOf("result"))
    }

    @Test fun theSeventeenthCallInFlightIsAnsweredUnavailable() {
        val release = CountDownLatch(1)
        val started = CountDownLatch(16)
        link.handlers.onCall = { _, _ -> started.countDown(); release.await(10, TimeUnit.SECONDS); CallOutcome.Ok(listOf(Part.Text("late"))) }
        val conn = link.connect()
        for (i in 1..16) conn.call("c$i")
        assertTrue(started.await(5, TimeUnit.SECONDS))
        conn.call("c17")
        val refused = conn.awaitFrame("result")
        assertEquals("c17", refused.getString("id"))
        assertFalse(refused.getBoolean("ok"))
        assertEquals("unavailable", refused.getJSONObject("error").getString("code"))
        assertEquals(1, results(conn).size)
        release.countDown()
        awaitTrue("the sixteen finish") { results(conn).size == 17 }
        assertTrue(results(conn).filter { it.getString("id") != "c17" }.all { it.getBoolean("ok") })
        // The slots are free again.
        conn.call("c18")
        awaitTrue("c18 answered") { results(conn).any { it.getString("id") == "c18" && it.getBoolean("ok") } }
    }

    @Test fun cancelStopsTheCallAndStillAnswersCancelledOnce() {
        val running = CountDownLatch(1)
        val interrupted = CountDownLatch(1)
        link.handlers.onCall = { _, _ ->
            running.countDown()
            try { Thread.sleep(10_000) } catch (_: InterruptedException) { interrupted.countDown() }
            CallOutcome.Ok(listOf(Part.Text("too late")))
        }
        val conn = link.connect()
        conn.call("c1")
        assertTrue(running.await(5, TimeUnit.SECONDS))
        conn.send(JSONObject().put("t", "cancel").put("id", "c1").put("reason", "cancelled"))
        val result = conn.awaitFrame("result")
        assertEquals("c1", result.getString("id"))
        assertFalse(result.getBoolean("ok"))
        assertEquals("cancelled", result.getJSONObject("error").getString("code"))
        assertTrue("the worker was interrupted", interrupted.await(5, TimeUnit.SECONDS))
        Thread.sleep(100)
        assertEquals("what the handler returns afterwards is dropped", 1, results(conn).size)
    }

    @Test fun aCooperativeHandlerSeesTheCancelFlag() {
        val seen = CountDownLatch(1)
        link.handlers.onCall = { _, ctx -> while (!ctx.isCancelled()) Thread.sleep(2); seen.countDown(); CallOutcome.Err("cancelled", "stopped") }
        val conn = link.connect()
        conn.call("c1")
        awaitTrue("running") { link.client.state == LinkClient.State.READY }
        Thread.sleep(50)
        conn.send(JSONObject().put("t", "cancel").put("id", "c1").put("reason", "cancelled"))
        assertEquals("cancelled", conn.awaitFrame("result").getJSONObject("error").getString("code"))
    }

    @Test fun cancelOfAnUnknownCallIsIgnored() {
        val conn = link.connect()
        conn.send(JSONObject().put("t", "cancel").put("id", "nope").put("reason", "cancelled"))
        conn.send(JSONObject().put("t", "ping").put("at", 1))
        conn.awaitFrame("pong")
        assertTrue(results(conn).isEmpty())
    }

    @Test fun aDroppedConnectionDropsTheResultsOfItsCalls() {
        val release = CountDownLatch(1)
        link.handlers.onCall = { _, _ -> try { release.await(10, TimeUnit.SECONDS) } catch (_: InterruptedException) {}; CallOutcome.Ok(listOf(Part.Text("x"))) }
        val conn = link.connect()
        conn.call("c1")
        conn.close(4500)
        awaitTrue("dropped") { link.handlers.closes.isNotEmpty() }
        release.countDown()
        link.clock.awaitTimer(1000); link.clock.advance(1000)
        val again = link.kernel.awaitConn(1)
        again.awaitFrame("hello"); again.welcome()
        Thread.sleep(150)
        assertTrue(results(again).isEmpty())
    }

    @Test fun assessIsAnsweredWithTheRisk() {
        link.handlers.onAssess = { capability, args -> Assessment("outward", "$capability ${args.optInt("x")}") }
        val conn = link.connect()
        conn.send(JSONObject().put("t", "assess").put("ch", "device").put("id", "a1").put("capability", "screen.tap").put("args", JSONObject().put("x", 5)))
        val assessed = conn.awaitFrame("assessed")
        assertEquals("a1", assessed.getString("id"))
        assertEquals("outward", assessed.getString("risk"))
        assertEquals("screen.tap 5", assessed.getString("why"))
    }

    @Test fun anAssessWithoutAnAnswerStaysSilent() {
        val conn = link.connect()
        conn.send(JSONObject().put("t", "assess").put("ch", "device").put("id", "a1").put("capability", "screen.tap").put("args", JSONObject()))
        conn.send(JSONObject().put("t", "ping").put("at", 1))
        conn.awaitFrame("pong")
        assertTrue(conn.framesOf("assessed").isEmpty())
    }

    @Test fun aBigImageTravelsAsAStreamSentBeforeTheResultThatPointsAtIt() {
        val image = ByteArray(600_000) { (it % 251).toByte() }
        link.handlers.onCall = { _, _ -> CallOutcome.Ok(listOf(Part.Text("shot"), Part.Image("image/png", Base64.getEncoder().encodeToString(image)))) }
        val conn = link.connect()
        conn.call("c1")
        val result = conn.awaitFrame("result")
        val parts = result.getJSONArray("content").objects()
        assertEquals("text", parts[0].getString("type"))
        val resource = parts[1]
        assertEquals("resource", resource.getString("type"))
        assertEquals("image/png", resource.getString("mime"))
        assertEquals(image.size, resource.getInt("size"))

        val sid = resource.getString("stream")
        val frames = conn.frames.filter { it.optString("sid") == sid }
        assertEquals("open", frames.first().getString("op"))
        assertEquals("device", frames.first().getString("ch"))
        assertEquals("c1", frames.first().getString("ref"))
        assertEquals("image/png", frames.first().getString("mime"))
        assertEquals(image.size, frames.first().getInt("size"))
        assertEquals("end", frames.last().getString("op"))
        val data = frames.filter { it.getString("op") == "data" }
        assertEquals((0 until data.size).toList(), data.map { it.getInt("seq") })
        assertTrue(data.size >= 3)
        val rebuilt = data.map { Base64.getDecoder().decode(it.getString("b64")) }.fold(ByteArray(0)) { a, b -> a + b }
        assertTrue(rebuilt.contentEquals(image))
        // The stream was finished before the result was sent.
        assertTrue(conn.frames.indexOf(frames.last()) < conn.frames.indexOf(result))
        assertTrue(data.all { Base64.getDecoder().decode(it.getString("b64")).size <= LinkProtocol.STREAM_CHUNK_BYTES })
    }

    @Test fun aSmallImageStaysInsideTheResult() {
        link.handlers.onCall = { _, _ -> CallOutcome.Ok(listOf(Part.Image("image/png", "AAAA"))) }
        val conn = link.connect()
        conn.call("c1")
        val part = conn.awaitFrame("result").getJSONArray("content").getJSONObject(0)
        assertEquals("image", part.getString("type"))
        assertEquals("AAAA", part.getString("b64"))
        assertTrue(conn.framesOf("stream").isEmpty())
    }

    @Test fun aLongTextAlsoTravelsAsAStream() {
        val text = "é".repeat(5000)
        link.handlers.onCall = { _, _ -> CallOutcome.Ok(listOf(Part.Text(text))) }
        val conn = link.connect()
        conn.call("c1")
        val part = conn.awaitFrame("result").getJSONArray("content").getJSONObject(0)
        assertEquals("resource", part.getString("type"))
        assertEquals(text.toByteArray().size, part.getInt("size"))
    }

    @Test fun inboundStreamsAreRefused() {
        val conn = link.connect()
        conn.send(JSONObject().put("t", "stream").put("sid", "s1").put("op", "open").put("ch", "human"))
        val answer = conn.awaitFrame("stream")
        assertEquals("error", answer.getString("op"))
        assertEquals("s1", answer.getString("sid"))
    }

    @Test fun anAgentFrameIsIgnoredBecauseThePhoneHasNoAgentChannel() {
        val conn = link.connect()
        conn.send(JSONObject().put("t", "agent").put("event", "agent.status"))
        conn.send(JSONObject().put("t", "ping").put("at", 1))
        conn.awaitFrame("pong")
        assertEquals(LinkClient.State.READY, link.client.state)
    }

    @Test fun aPresentFrameIsAnsweredUnavailableUntilTheHumanChannelShowsIt() {
        val conn = link.connect()
        conn.send(JSONObject().put("t", "present").put("ch", "human").put("id", "p1").put("surface", "island").put("op", "query").put("body", JSONObject()))
        val result = conn.awaitFrame("present.result")
        assertEquals("p1", result.getString("id"))
        assertFalse(result.getBoolean("ok"))
        assertEquals("unavailable", result.getJSONObject("error").getString("code"))
    }
}
