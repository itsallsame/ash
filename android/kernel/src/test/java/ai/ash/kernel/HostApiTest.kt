package ai.ash.kernel

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** The host interface, and its end of the core's private pipe, with the Keystore, alarm clock and hand binding replaced. */
class HostApiTest {
    private val identity = SoftIdentity()
    private val alarms = FakeAlarms()
    private val power = FakePower()
    private val hands = FakeHands()
    private val callbacks = FakeCallbacks()
    private lateinit var api: HostApi

    private fun start(capabilities: List<String> = HostApi.CAPABILITIES) {
        api = HostApi(capabilities, identity, WakeManager(alarms), power, hands, callbacks)
    }

    @Before fun setUp() = start()

    private fun post(method: String, body: String = "{}"): JSONObject = api.call(method, JSONObject(body))

    private fun ok(method: String, body: String = "{}"): JSONObject {
        val json = post(method, body)
        assertTrue("$method: $json", json.getBoolean("ok"))
        return json.getJSONObject("result")
    }

    private fun errorOf(r: JSONObject, code: String) {
        assertFalse(r.getBoolean("ok"))
        assertEquals(code, r.getJSONObject("error").getString("code"))
    }

    // ---- the pipe

    /** A core whose standard input is a list of lines. */
    private class Lines : NodeHandle {
        val written = java.util.Collections.synchronizedList(ArrayList<String>())
        var latch = CountDownLatch(1)
        override fun isRunning() = true
        override fun writeEvent(line: String): Boolean { written += line; latch.countDown(); return true }
        override fun stop(stopLine: String?, graceMs: Long) {}
    }

    @Test fun aCallLineIsAnsweredOnTheCoresInputWithItsId() {
        val logs = ArrayList<String>()
        val pipe = HostPipe(api) { logs += it }
        val core = Lines()
        pipe.take(core, """{"call":7,"method":"status.set","params":{"text":"x","state":"running"}}""")
        assertTrue(core.latch.await(5, TimeUnit.SECONDS))
        val reply = JSONObject(core.written.single())
        assertEquals(7, reply.getInt("reply"))
        assertTrue(reply.getBoolean("ok"))
        assertEquals(listOf("x" to "running"), callbacks.statuses)
    }

    @Test fun whatIsNotACallIsOnlyLoggedNeverObeyed() {
        val logs = ArrayList<String>()
        val pipe = HostPipe(api) { logs += it }
        val core = Lines()
        for (line in listOf("{not json", """{"method":"wake.at","params":{"at":5}}""", """{"call":"1","method":"wake.at"}""", "plain log text")) pipe.take(core, line)
        Thread.sleep(100)
        assertTrue(core.written.isEmpty())
        assertTrue(alarms.sets.isEmpty())
        assertEquals(4, logs.size)
    }

    @Test fun theBootLineCarriesTheSealKeyAndNothingElse() {
        assertEquals("""{"boot":{"seal_key":"abc"}}""", HostPipe.bootLine("abc"))
    }

    @Test fun everyCallCountsAsActivity() {
        ok("status.set", """{"text":"x","state":"running"}""")
        assertEquals(1, callbacks.activity)
    }

    @Test fun unknownThingsAreNotFound() {
        errorOf(post("nope"), "not_found")
        // update.install is a known method of a capability this host does not declare.
        errorOf(post("update.install", """{"version":"1","url":"u","sha256":"s"}"""), "not_found")
    }

    @Test fun methodsOfUndeclaredCapabilitiesAreNotFound() {
        start(listOf("identity", "lifecycle", "status"))
        errorOf(post("wake.at", """{"at":5}"""), "not_found")
        errorOf(post("power.hold", """{"ms":5,"reason":"x"}"""), "not_found")
        errorOf(post("hands.handoff", """{"port":5,"token":"x"}"""), "not_found")
        ok("identity.key")
    }

    // ---- identity

    @Test fun identityKeyAndSign() {
        val k = ok("identity.key")
        val spki = Codec.unb64u(k.getString("public_key"))
        assertArrayEquals(identity.publicKey(), spki)
        val expectedId = Codec.b64u(MessageDigest.getInstance("SHA-256").digest(spki)).substring(0, 22)
        assertEquals(expectedId, k.getString("id"))
        assertEquals(22, k.getString("id").length)

        val data = "challenge-nonce".toByteArray()
        val sig = Codec.unb64u(ok("identity.sign", """{"data":"${Codec.b64u(data)}"}""").getString("sig"))
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki)))
        verifier.update(data)
        assertTrue("DER ECDSA signature verifies", verifier.verify(sig))
    }

    @Test fun signRejectsWhatIsNotBase64url() {
        errorOf(post("identity.sign", """{"data":"not base64 !!"}"""), "bad_request")
        errorOf(post("identity.sign", "{}"), "bad_request")
        errorOf(post("identity.sign", """{"data":5}"""), "bad_request")
    }

    // ---- lifecycle and status

    @Test fun lifecycleReadyRestartAndStatus() {
        assertEquals("{}", ok("lifecycle.ready", """{"version":"0.4.0","link_port":43999}""").toString())
        assertEquals(listOf("0.4.0" to 43999), callbacks.ready)
        ok("lifecycle.restart", """{"reason":"plugin change"}""")
        assertEquals(listOf("plugin change"), callbacks.restarts)
        ok("status.set", """{"text":"运行中","state":"running"}""")
        assertEquals(listOf("运行中" to "running"), callbacks.statuses)
        errorOf(post("status.set", """{"text":"x","state":"flying"}"""), "bad_request")
        errorOf(post("lifecycle.ready", """{"version":"1","link_port":0}"""), "bad_request")
    }

    // ---- wake and power

    @Test fun wakeKeepsTheEarliestAndClearCancels() {
        ok("wake.at", """{"at":2000000}""")
        ok("wake.at", """{"at":3000000}""")
        assertEquals(listOf(2_000_000L), alarms.sets)
        ok("wake.at", """{"at":1500000}""")
        assertEquals(listOf(2_000_000L, 1_500_000L), alarms.sets)
        ok("wake.clear")
        assertEquals(1, alarms.cancels)
        ok("wake.at", """{"at":9000000}""")
        assertEquals(9_000_000L, alarms.sets.last())
        errorOf(post("wake.at", """{"at":"soon"}"""), "bad_request")
        errorOf(post("wake.at", "{}"), "bad_request")
    }

    @Test fun powerHoldIsCappedAndReleaseReleases() {
        ok("power.hold", """{"ms":30000,"reason":"turn"}""")
        ok("power.hold", """{"ms":99999999,"reason":"too long"}""")
        assertEquals(listOf(30_000L to "turn", 600_000L to "too long"), power.holds)
        ok("power.release")
        assertEquals(1, power.releases)
        errorOf(post("power.hold", """{"ms":0,"reason":"x"}"""), "bad_request")
    }

    // ---- hands

    @Test fun handoffGoesToTheHands() {
        val r = ok("hands.handoff", """{"port":43555,"token":"link-token"}""")
        assertEquals(listOf(43555 to "link-token"), hands.calls)
        assertEquals("ai.ash.agent", r.getJSONArray("delivered").getString(0))
        hands.delivered = emptyList()
        assertEquals(0, ok("hands.handoff", """{"port":43555,"token":"link-token"}""").getJSONArray("delivered").length())
        errorOf(post("hands.handoff", """{"port":70000,"token":"t"}"""), "bad_request")
        errorOf(post("hands.handoff", """{"port":5}"""), "bad_request")
    }

    @Test fun capabilitiesDoNotListUpdate() {
        assertFalse("update" in HostApi.CAPABILITIES)
    }
}
