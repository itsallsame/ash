package ai.ash.link

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Base64

/** The same JSON samples the TypeScript side checks (`packages/sdk/fixtures/link`): `<frame type>__<why>.json`. */
class FramesConformanceTest {
    private val codec = Repo.codec

    private fun fixtures(kind: String): List<Triple<String, String, Any>> =
        File(Repo.fixtureDir, kind).listFiles { f -> f.name.endsWith(".json") }!!.sortedBy { it.name }.map { f ->
            Triple(f.name, f.name.substringBefore("__"), JSONObject(f.readText()))
        }

    private fun checkAs(type: String, value: Any): String? = if (type == "capability-spec") codec.capabilityError(value) else codec.error(type, value)

    @Test fun everyValidFixturePasses() {
        val all = fixtures("valid")
        assertTrue(all.size > 50)
        for ((file, type, value) in all) {
            assertTrue("$file: unknown type", type == "capability-spec" || type in codec.frameTypes)
            assertNull(file, checkAs(type, value))
            if (type != "capability-spec") {
                val decoded = codec.decode(value.toString())
                assertTrue("$file: decode", decoded is Decoded.Ok)
                assertEquals(file, type, (decoded as Decoded.Ok).type)
            }
        }
    }

    @Test fun everyInvalidFixtureIsRejected() {
        val all = fixtures("invalid")
        assertTrue(all.size > 70)
        for ((file, type, value) in all) {
            assertTrue("$file: unknown type", type == "capability-spec" || type in codec.frameTypes)
            assertNotNull("$file should be rejected", checkAs(type, value))
            if (type != "capability-spec") assertTrue("$file: decode", codec.decode(value.toString()) is Decoded.Bad)
        }
    }

    @Test fun eachFrameTypeHasOneValidAndTwoInvalidSamples() {
        for (type in codec.frameTypes + "capability-spec") {
            assertTrue("$type: valid", fixtures("valid").any { it.second == type })
            assertTrue("$type: invalid", fixtures("invalid").count { it.second == type } >= 2)
        }
    }

    @Test fun theConstantsMatchTheSchemaIndex() {
        val index = codec.index
        val limits = index.getJSONObject("limits")
        assertEquals(LinkProtocol.FRAME_BYTES, limits.getInt("frameBytes"))
        assertEquals(LinkProtocol.STREAM_CHUNK_BYTES, limits.getInt("streamChunkBytes"))
        assertEquals(LinkProtocol.INFLIGHT_CALLS, limits.getInt("inflightCalls"))
        assertEquals(LinkProtocol.HEARTBEAT_MS, limits.getLong("heartbeatMs"))
        assertEquals(LinkProtocol.SILENCE_MS, limits.getLong("silenceMs"))
        assertEquals(LinkProtocol.NAME, index.getString("protocol"))
        val codes = index.getJSONObject("close_codes")
        assertEquals(CloseCodes.NORMAL, codes.getInt("normal"))
        assertEquals(CloseCodes.UNAUTHENTICATED, codes.getInt("unauthenticated"))
        assertEquals(CloseCodes.REVOKED, codes.getInt("revoked"))
        assertEquals(CloseCodes.UNSUPPORTED, codes.getInt("unsupported"))
        assertEquals(CloseCodes.SUPERSEDED, codes.getInt("superseded"))
        assertEquals(CloseCodes.BAD_FRAME, codes.getInt("badFrame"))
        assertEquals(CloseCodes.INTERNAL, codes.getInt("internal"))
        val noReconnect = index.getJSONArray("no_reconnect")
        assertEquals(CloseCodes.NO_RECONNECT, (0 until noReconnect.length()).map { noReconnect.getInt(it) }.toSet())
    }

    @Test fun aFrameIsCheckedAsTheTypeItsTNames() {
        assertTrue(codec.decode("""{"t":"nope"}""") is Decoded.Bad)
        assertTrue(codec.decode("null") is Decoded.Bad)
        assertTrue(codec.decode("[]") is Decoded.Bad)
        assertTrue(codec.decode("""{"t":"ping","at":1}""") is Decoded.Ok)
        assertNotNull(codec.error("pong", JSONObject("""{"t":"ping","at":1}""")))
    }

    @Test fun textThatIsNotOneJsonObjectIsRefused() {
        assertTrue(codec.decode("""{"t":"ping","at":1} trailing""") is Decoded.Bad)
        assertTrue(codec.decode("""{"t":"ping","at":1}{"t":"ping","at":1}""") is Decoded.Bad)
        assertTrue(codec.decode("{not json") is Decoded.Bad)
        assertTrue(codec.decode("") is Decoded.Bad)
    }

    @Test fun unknownFieldsAreRefusedInStrictFrames() {
        assertNotNull(codec.error("ping", JSONObject("""{"t":"ping","at":1,"extra":true}""")))
        // `body` of an event is open: the payload belongs to another contract.
        assertNull(codec.error("event", JSONObject("""{"t":"event","ch":"device","id":"e1","word":"sense.battery","body":{"anything":[1,2]},"at":1}""")))
    }

    @Test fun aHelloOfAnotherProtocolStillHasAValidShapeSoTheKernelCanAnswer4008() {
        val hello = """{"t":"hello","protocol":"ash-link/9","hand":{"kind":"phone","name":"p","version":"1","platform":"x"},"channels":{"device":{}}}"""
        assertTrue(codec.decode(hello) is Decoded.Ok)
    }

    @Test fun aStreamChunkAtTheLimitFitsAndOneMoreGroupOfBytesDoesNot() {
        fun chunk(bytes: Int) = JSONObject().put("t", "stream").put("sid", "s").put("op", "data").put("seq", 0)
            .put("b64", Base64.getEncoder().encodeToString(ByteArray(bytes) { 1 }))
        assertNull(codec.error("stream", chunk(LinkProtocol.STREAM_CHUNK_BYTES)))
        assertNotNull(codec.error("stream", chunk(LinkProtocol.STREAM_CHUNK_BYTES + 3)))
    }

    @Test fun anIntegerMayBeWrittenWithADecimalPointLikeInJavaScript() {
        assertNull(codec.error("ping", JSONObject("""{"t":"ping","at":5.0}""")))
        assertNotNull(codec.error("ping", JSONObject("""{"t":"ping","at":5.5}""")))
    }

    @Test fun anOversizedFrameIsRefusedBothWays() {
        val big = "x".repeat(LinkProtocol.FRAME_BYTES)
        assertTrue(codec.decode("""{"t":"error","code":"failed","message":"$big"}""") is Decoded.Bad)
        val frame = JSONObject().put("t", "error").put("code", "failed").put("message", big)
        try { codec.encode(frame); throw AssertionError("should not encode") } catch (_: FrameCodec.FrameTooLarge) {}
    }

    @Test fun encodingRefusesAFrameThatBreaksTheProtocol() {
        try { codec.encode(JSONObject().put("t", "ping")); throw AssertionError("should not encode") } catch (_: IllegalArgumentException) {}
        try { codec.encode(JSONObject().put("hello", 1)); throw AssertionError("should not encode") } catch (_: IllegalArgumentException) {}
        assertEquals("""{"t":"pong","at":3}""".length, codec.encode(JSONObject().put("t", "pong").put("at", 3)).length)
    }

    @Test fun everySchemaOfTheIndexLoadsWithOnlyKnownKeywords() {
        // FrameCodec reads and keyword-checks every file of the index when it is built; a keyword it cannot enforce would have thrown.
        assertEquals(codec.index.getJSONObject("frames").length(), codec.frameTypes.size)
        for (type in codec.frameTypes) assertTrue(codec.senderOf(type) in setOf("kernel", "hand", "both"))
    }
}
