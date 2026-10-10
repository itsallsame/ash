package ai.ash.kernel

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/** The host interface over a real loopback socket, with the Keystore, alarm clock and hand binding replaced. */
class HostApiTest {
    private val identity = SoftIdentity()
    private val alarms = FakeAlarms()
    private val power = FakePower()
    private val hands = FakeHands()
    private val callbacks = FakeCallbacks()
    private lateinit var api: HostApi
    private lateinit var server: KernelHostServer

    private fun start(capabilities: List<String> = HostApi.CAPABILITIES) {
        api = HostApi(capabilities, identity, WakeManager(alarms), power, hands, callbacks)
        api.token = TOKEN
        server = KernelHostServer(api)
        server.start()
    }

    @Before fun setUp() = start()
    @After fun tearDown() = server.stop()

    private fun post(method: String, body: String = "{}", token: String? = TOKEN, verb: String = "POST", path: String = "/v1/$method"): Pair<Int, JSONObject> {
        val c = URL(server.endpoint + path).openConnection() as HttpURLConnection
        c.requestMethod = verb
        if (token != null) c.setRequestProperty("Authorization", "Bearer $token")
        if (verb == "POST") { c.doOutput = true; c.outputStream.use { it.write(body.toByteArray()) } }
        val code = c.responseCode
        val text = (if (code < 400) c.inputStream else c.errorStream).use { it.readBytes().toString(Charsets.UTF_8) }
        return code to JSONObject(text)
    }

    private fun ok(method: String, body: String = "{}"): JSONObject {
        val (code, json) = post(method, body)
        assertEquals("$method: $json", 200, code)
        assertTrue(json.getBoolean("ok"))
        return json.getJSONObject("result")
    }

    private fun errorOf(r: Pair<Int, JSONObject>, status: Int, code: String) {
        assertEquals(status, r.first)
        assertFalse(r.second.getBoolean("ok"))
        assertEquals(code, r.second.getJSONObject("error").getString("code"))
    }

    // ---- authentication

    @Test fun wrongTokenIs401() {
        errorOf(post("identity.key", token = "nope"), 401, "unauthorized")
        errorOf(post("identity.key", token = null), 401, "unauthorized")
        errorOf(post("identity.key", token = TOKEN + "x"), 401, "unauthorized")
    }

    @Test fun noRunningCoreMeansNoToken() {
        api.token = null
        errorOf(post("status.set", """{"text":"x","state":"running"}"""), 401, "unauthorized")
        assertEquals(0, callbacks.statuses.size)
    }

    @Test fun refusedCallsAreNotHeartbeats() {
        post("status.set", """{"text":"x","state":"running"}""", token = "nope")
        assertEquals(0, callbacks.activity)
        ok("status.set", """{"text":"x","state":"running"}""")
        assertEquals(1, callbacks.activity)
    }

    @Test fun unknownThingsAre404() {
        errorOf(post("nope"), 404, "not_found")
        errorOf(post("identity.key", verb = "GET"), 404, "not_found")
        errorOf(post("identity.key", path = "/identity.key"), 404, "not_found")
        // update.install is a known method of a capability this host does not declare.
        errorOf(post("update.install", """{"version":"1","url":"u","sha256":"s"}"""), 404, "not_found")
    }

    @Test fun methodsOfUndeclaredCapabilitiesAreNotFound() {
        server.stop()
        start(listOf("identity", "lifecycle", "status"))
        errorOf(post("wake.at", """{"at":5}"""), 404, "not_found")
        errorOf(post("power.hold", """{"ms":5,"reason":"x"}"""), 404, "not_found")
        errorOf(post("hands.handoff", """{"port":5,"token":"x"}"""), 404, "not_found")
        ok("identity.key")
    }

    @Test fun badJsonIs400() {
        errorOf(post("status.set", "{not json"), 400, "bad_request")
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
        errorOf(post("identity.sign", """{"data":"not base64 !!"}"""), 400, "bad_request")
        errorOf(post("identity.sign", "{}"), 400, "bad_request")
        errorOf(post("identity.sign", """{"data":5}"""), 400, "bad_request")
    }

    // ---- lifecycle and status

    @Test fun lifecycleReadyRestartAndStatus() {
        assertEquals("{}", ok("lifecycle.ready", """{"version":"0.4.0","link_port":43999}""").toString())
        assertEquals(listOf("0.4.0" to 43999), callbacks.ready)
        ok("lifecycle.restart", """{"reason":"plugin change"}""")
        assertEquals(listOf("plugin change"), callbacks.restarts)
        ok("status.set", """{"text":"运行中","state":"running"}""")
        assertEquals(listOf("运行中" to "running"), callbacks.statuses)
        errorOf(post("status.set", """{"text":"x","state":"flying"}"""), 400, "bad_request")
        errorOf(post("lifecycle.ready", """{"version":"1","link_port":0}"""), 400, "bad_request")
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
        errorOf(post("wake.at", """{"at":"soon"}"""), 400, "bad_request")
        errorOf(post("wake.at", "{}"), 400, "bad_request")
    }

    @Test fun powerHoldIsCappedAndReleaseReleases() {
        ok("power.hold", """{"ms":30000,"reason":"turn"}""")
        ok("power.hold", """{"ms":99999999,"reason":"too long"}""")
        assertEquals(listOf(30_000L to "turn", 600_000L to "too long"), power.holds)
        ok("power.release")
        assertEquals(1, power.releases)
        errorOf(post("power.hold", """{"ms":0,"reason":"x"}"""), 400, "bad_request")
    }

    // ---- hands

    @Test fun handoffGoesToTheHands() {
        val r = ok("hands.handoff", """{"port":43555,"token":"link-token"}""")
        assertEquals(listOf(43555 to "link-token"), hands.calls)
        assertEquals("ai.ash.agent", r.getJSONArray("delivered").getString(0))
        hands.delivered = emptyList()
        assertEquals(0, ok("hands.handoff", """{"port":43555,"token":"link-token"}""").getJSONArray("delivered").length())
        errorOf(post("hands.handoff", """{"port":70000,"token":"t"}"""), 400, "bad_request")
        errorOf(post("hands.handoff", """{"port":5}"""), 400, "bad_request")
    }

    @Test fun capabilitiesDoNotListUpdate() {
        assertFalse("update" in HostApi.CAPABILITIES)
    }

    private companion object { const val TOKEN = "t0ken-for-tests" }
}
