package ai.ash.host.apps

import ai.ash.human.HumanSend
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class AppsBridgeTest {
    private val sent = mutableListOf<JSONObject>()
    private var uid = 1000
    private var answer: () -> JSONObject = { JSONObject().put("ok", true).put("response", JSONObject().put("ok", true).put("result", JSONObject().put("data", JSONObject().put("n", 1)))) }

    private fun bridge(app: String?) = AppsBridge(app, 1000, { uid }) { request -> sent += request; answer() }
    private fun call(b: AppsBridge, to: String, word: String, body: String = "{}") = JSONObject(b.call(to, word, body))

    private fun refused(r: JSONObject): Boolean = !r.getBoolean("ok") && r.getJSONObject("error").getString("code") == "forbidden"

    // --- the policy ---

    @Test fun thePolicyLetsThroughTheThreeServiceWordsAndTheAppsOwnTools() {
        fun allows(app: String?, to: String, word: String, body: String = "{}") = AppsBridgePolicy.allows(app, to, word, JSONObject(body))
        assertTrue(allows("health", "service:apps", "apps.list"))
        assertTrue(allows(null, "service:apps", "apps.list"))
        assertTrue(allows("health", "service:apps", "apps.surface", """{"id":"health","surface":"home"}"""))
        assertTrue(allows("health", "service:apps", "apps.icon", """{"id":"health"}"""))
        assertTrue(allows(null, "service:apps", "apps.icon", """{"id":"notes"}"""))
        assertTrue(allows("health", "app:health", "health.today"))
        assertTrue(allows("health", "app:health", "ash.on_event"))
    }

    @Test fun thePolicyRefusesEverythingElse() {
        fun allows(app: String?, to: String, word: String, body: String = "{}") = AppsBridgePolicy.allows(app, to, word, JSONObject(body))
        // other words of service:apps (installing is the owner's, in Ash itself), other services and members
        for (word in listOf("apps.install", "apps.describe", "apps.remove", "apps.enable", "apps.contract", "apps.scaffold")) assertFalse(word, allows("health", "service:apps", word, """{"id":"health"}"""))
        for (to in listOf("service:gate", "service:vault", "service:agents", "person:owner", "agent:main", "device:abc", "body:main", "client:x", "service:apps2", "service:apps/x")) {
            assertFalse(to, allows("health", to, "apps.list"))
            assertFalse(to, allows("health", to, "health.today"))
        }
        // another app's tools, or ones that only look like this app
        assertFalse(allows("health", "app:bank", "bank.pay"))
        assertFalse(allows("health", "app:health2", "health.today"))
        assertFalse(allows("health", "app:healt", "health.today"))
        assertFalse(allows("health", "app:health ", "health.today"))
        assertFalse(allows("health", "app:Health", "health.today"))
        assertFalse(allows("health", "app:*", "health.today"))
        assertFalse(allows("health", "app:", "x"))
        // the list screen has no app: no tools, no pages
        assertFalse(allows(null, "app:health", "health.today"))
        assertFalse(allows(null, "service:apps", "apps.surface", """{"id":"health","surface":"home"}"""))
        // a page asks for its own page and icon, not another app's
        assertFalse(allows("health", "service:apps", "apps.surface", """{"id":"bank","surface":"home"}"""))
        assertFalse(allows("health", "service:apps", "apps.icon", """{"id":"bank"}"""))
        assertFalse(allows("health", "service:apps", "apps.surface"))
        assertFalse(allows(null, "service:apps", "apps.icon", """{"id":"../x"}"""))
        assertFalse(allows(null, "service:apps", "apps.icon"))
        // a word that is not a tool name
        for (word in listOf("", " ", "../x", "a b", "x".repeat(129), "a\nb", "a:b")) assertFalse("[$word]", allows("health", "app:health", word))
    }

    // --- the bridge ---

    @Test fun anAllowedCallIsSentAsTheOwnerWaitingForTheAnswerAndItsReplyComesBack() {
        val r = call(bridge("health"), "app:health", "health.log", """{"kg":70}""")
        val request = sent.single()
        assertEquals("app:health", request.getString("to"))
        assertEquals("request", request.getString("kind"))
        assertEquals("health.log", request.getString("word"))
        assertEquals(70, request.getJSONObject("body").getInt("kg"))
        assertTrue(request.getBoolean("wait"))
        assertTrue(r.getBoolean("ok"))
        assertEquals(1, r.getJSONObject("result").getJSONObject("data").getInt("n"))
    }

    @Test fun theKernelsFailureReplyComesBackAsItIs() {
        val failure = JSONObject().put("ok", false).put("error", JSONObject().put("code", "failed").put("message", "disk full").put("owner_text", "磁盘满了"))
        answer = { JSONObject().put("ok", true).put("response", failure) }
        val r = call(bridge("health"), "app:health", "health.log")
        assertEquals(failure.toString(), r.toString())
    }

    @Test fun aCallerOfAnotherUidIsRefusedAndNothingIsSent() {
        uid = 10234
        val b = bridge("health")
        assertTrue(refused(call(b, "service:apps", "apps.list")))
        assertTrue(refused(call(b, "app:health", "health.today")))
        assertTrue(sent.isEmpty())
    }

    @Test fun whatThePolicyRefusesIsNotSent() {
        val b = bridge("health")
        assertTrue(refused(call(b, "app:bank", "bank.pay")))
        assertTrue(refused(call(b, "service:vault", "list")))
        assertTrue(refused(call(b, "service:apps", "apps.install", """{"id":"health"}""")))
        assertTrue(refused(call(bridge(null), "app:health", "health.today")))
        assertTrue(sent.isEmpty())
    }

    @Test fun badInputIsRefusedBeforeItIsSent() {
        val b = bridge("health")
        assertEquals("bad_request", JSONObject(b.call("app:health", "health.today", "{not json")).getJSONObject("error").getString("code"))
        assertEquals("bad_request", JSONObject(b.call(null, "health.today", "{}")).getJSONObject("error").getString("code"))
        assertEquals("bad_request", JSONObject(b.call("app:health", null, "{}")).getJSONObject("error").getString("code"))
        assertEquals("bad_request", JSONObject(b.call("app:health", "health.today", null)).getJSONObject("error").getString("code"))
        assertEquals("too_large", JSONObject(b.call("app:health", "health.today", "{\"a\":\"" + "x".repeat(AppsBridge.MAX_BODY) + "\"}")).getJSONObject("error").getString("code"))
        assertTrue(sent.isEmpty())
    }

    @Test fun noConnectionRefusalAndNoAnswerAreErrorsNotCrashes() {
        answer = { throw IOException("not connected") }
        assertEquals("offline", call(bridge("health"), "app:health", "health.today").getJSONObject("error").getString("code"))
        answer = { throw HumanSend.Refused("forbidden", "no") }
        assertEquals("forbidden", call(bridge("health"), "app:health", "health.today").getJSONObject("error").getString("code"))
        answer = { JSONObject().put("ok", true) }
        assertEquals("result_unknown", call(bridge("health"), "app:health", "health.today").getJSONObject("error").getString("code"))
        answer = { throw IllegalStateException("boom") }
        assertEquals("internal", call(bridge("health"), "app:health", "health.today").getJSONObject("error").getString("code"))
    }
}
