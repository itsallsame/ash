package ai.ash.human

import ai.ash.link.TestLink
import ai.ash.link.awaitTrue
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CompletableFuture

/** The owner's words from a notification, the island, a card or the stop button: `send` frames, with the kernel's answer. */
class HumanSendTest {
    private val link = TestLink()
    @After fun end() = link.close()

    private fun say(text: String = "hi", wait: Boolean = false) = JSONObject().put("to", "agent:main").put("kind", "request").put("word", "say")
        .put("body", JSONObject().put("text", text)).put("client_id", "c1").put("wait", wait)

    @Test fun aWordTheKernelTookReturnsItsSendResult() {
        val conn = link.connect()
        val answer = CompletableFuture.supplyAsync { HumanSend.send(link.client, say()) }
        val sent = conn.awaitFrame("send")
        assertEquals("c1", sent.getJSONObject("request").getString("client_id"))
        conn.send(JSONObject().put("t", "send.result").put("id", sent.getString("id")).put("ok", true).put("message", JSONObject().put("id", "m1").put("seq", 3)).put("duplicate", true))
        val result = answer.get(5, java.util.concurrent.TimeUnit.SECONDS)
        assertEquals("m1", result.getJSONObject("message").getString("id"))
        assertNull(HumanSend.reply(result))
    }

    @Test fun aWordTheKernelRefusedThrowsItsCodeAndSaysWhetherAskingAgainCouldHelp() {
        val conn = link.connect()
        for ((code, final) in listOf("forbidden" to true, "bad_request" to true, "conflict" to true, "unavailable" to false, "internal" to false, "timeout" to false)) {
            val answer = CompletableFuture.supplyAsync { runCatching { HumanSend.send(link.client, say()) }.exceptionOrNull() }
            awaitTrue("a send for $code") { conn.framesOf("send").size > listOf("forbidden", "bad_request", "conflict", "unavailable", "internal", "timeout").indexOf(code) }
            val sent = conn.framesOf("send").last()
            conn.send(JSONObject().put("t", "send.result").put("id", sent.getString("id")).put("ok", false).put("error", JSONObject().put("code", code).put("message", "no: $code")))
            val error = answer.get(5, java.util.concurrent.TimeUnit.SECONDS) as HumanSend.Refused
            assertEquals(code, error.code); assertEquals("no: $code", error.message); assertEquals(final, error.final)
        }
    }

    @Test fun withoutAConnectionOrWithAFrameThatBreaksTheProtocolItThrows() {
        try { HumanSend.send(link.client, say()); fail("no connection") } catch (e: IOException) { assertFalse(e is HumanSend.Refused) }
        link.connect()
        try { HumanSend.send(link.client, JSONObject().put("to", "agent:main").put("kind", "request").put("word", "say")); fail("no body") }
        catch (e: HumanSend.Refused) { assertEquals("bad_request", e.code); assertTrue(e.final) }
    }

    @Test fun theResponseToAWaitedWordIsTheReplyItself() {
        val reply = JSONObject().put("ok", true).put("result", JSONObject().put("data", JSONObject().put("ended", true)))
        val sent = JSONObject().put("response", reply)
        assertTrue(HumanSend.reply(sent)!!.getBoolean("ok"))
        assertTrue(HumanSend.data(sent)!!.getBoolean("ended"))
        // A response message wrapping the reply is not a reply.
        assertNull(HumanSend.data(JSONObject().put("response", JSONObject().put("kind", "response").put("body", reply))))
        val failed = JSONObject().put("response", JSONObject().put("ok", false).put("error", JSONObject().put("code", "denied").put("message", "n")))
        assertNull(HumanSend.data(failed))
        assertNull(HumanSend.reply(JSONObject()))
    }
}
