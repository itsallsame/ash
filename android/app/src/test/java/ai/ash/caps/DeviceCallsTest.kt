package ai.ash.caps

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import ai.ash.link.Assessment
import ai.ash.link.CallOutcome
import ai.ash.link.Part
import ai.ash.link.Repo

/** How a capability's result becomes the content of a `result` frame. */
class DeviceCallsTest {
    private fun ok(outcome: CallOutcome) = outcome as CallOutcome.Ok
    private fun err(outcome: CallOutcome) = outcome as CallOutcome.Err

    @Test fun textAndImageAndDataBecomeContentParts() {
        val data = JSONObject().put("w", 1080)
        val outcome = ok(DeviceCalls.outcomeOf(CapResult.textAndImage("see", "QUJD", "image/jpeg", data)))
        assertEquals(2, outcome.content.size)
        assertEquals("see", (outcome.content[0] as Part.Text).text)
        val image = outcome.content[1] as Part.Image
        assertEquals("image/jpeg", image.mime)
        assertEquals("QUJD", image.b64)
        assertEquals(1080, (outcome.data as JSONObject).getInt("w"))
    }

    @Test fun aResultWithoutDataHasNone() {
        assertNull(ok(DeviceCalls.outcomeOf(CapResult.text("hi"))).data)
    }

    @Test fun everyPartOfAResultIsAValidContentPartFrame() {
        val codec = Repo.codec
        val result = ok(DeviceCalls.outcomeOf(CapResult.textAndImage("see", "QUJD", "image/png")))
        val content = org.json.JSONArray()
        for (part in result.content) content.put(when (part) {
            is Part.Text -> JSONObject().put("type", "text").put("text", part.text)
            is Part.Image -> JSONObject().put("type", "image").put("mime", part.mime).put("b64", part.b64)
        })
        codec.encode(JSONObject().put("t", "result").put("id", "c1").put("ok", true).put("content", content))
    }

    @Test fun failuresGetTheUnifiedCodes() {
        assertEquals("not_found", err(DeviceCalls.outcomeOf(CapResult.error("not_found", "the phone has no capability x.y"))).code)
        assertEquals("unavailable", err(DeviceCalls.outcomeOf(CapResult.error("unavailable", "screen.tap is not available right now"))).code)
        assertEquals("failed", err(DeviceCalls.outcomeOf(CapResult.fail("boom"))).code)
        assertEquals("cancelled", err(DeviceCalls.outcomeOf(CapResult.error("cancelled", "stopped"))).code)
        assertEquals("timeout", err(DeviceCalls.outcomeOf(CapResult.error("timeout", "too slow"))).code)
    }

    @Test fun theMessageIsTheSpecificReasonWithoutTheCodeInFront() {
        val outcome = err(DeviceCalls.outcomeOf(CapResult.error("forbidden", "location permission is not granted")))
        assertEquals("forbidden", outcome.code)
        assertEquals("location permission is not granted", outcome.message)
        assertNull(outcome.detail)
    }

    @Test fun aCodeThatIsNotAUnifiedOneCannotBeMade() {
        try { CapResult.error("permission_denied", "x"); throw AssertionError("should refuse") } catch (_: IllegalArgumentException) {}
    }

    @Test fun assessGivesTheDeclaredRiskAndTheRiskiestForAnUnknownCapability() {
        assertEquals("outward", HandHandlersProbe.assess("screen.tap").risk)
        assertEquals("none", HandHandlersProbe.assess("screen.read").risk)
        assertEquals("structure", HandHandlersProbe.assess("shell.run").risk)
        assertEquals("structure", HandHandlersProbe.assess("nope.nothing").risk)
        assertEquals("none", HandHandlersProbe.assess("decision.surface").risk)
        assertEquals("structure", HandHandlersProbe.assess("config.keepalive.fix").risk)
        // The old name of a renamed capability is no longer one.
        assertEquals("structure", HandHandlersProbe.assess("intent.view").risk)
    }

    /** [DeviceCalls] needs a Context for the decision host; `assess` does not touch it, so it is reached through the same rules. */
    private object HandHandlersProbe {
        fun assess(capability: String): Assessment = DeviceCalls.assessmentFor(capability)
    }
}
