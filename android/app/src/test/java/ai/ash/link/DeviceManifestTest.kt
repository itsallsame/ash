package ai.ash.link

import ai.ash.host.cap.Cap
import ai.ash.host.cap.CapResult
import ai.ash.host.cap.CapabilityPolicies
import ai.ash.host.cap.CapabilityPolicy
import ai.ash.host.senses.SensesEvents
import ai.ash.senses.Batches
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceManifestTest {
    private val codec = Repo.codec

    @Test fun everyPolicyOfTheRegistryIsACapabilitySpecTheKernelAccepts() {
        for ((name, policy) in CapabilityPolicies.byName) {
            val cap = Cap(name, "does $name") { _, _ -> CapResult.text("ok") }
            val spec = DeviceManifest.spec(cap, policy)
            assertNull("$name: ${codec.capabilityError(spec)}", codec.capabilityError(spec))
        }
    }

    @Test fun theSpecCarriesTheNameThePolicyAndTheForegroundMark() {
        val tap = DeviceManifest.spec(Cap("screen.tap", "Tap") { _, _ -> CapResult.text("ok") }, CapabilityPolicies.require("screen.tap"))
        assertEquals("act", tap.getString("effect"))
        assertEquals("outward", tap.getString("risk"))
        assertTrue(tap.getBoolean("foreground"))
        assertEquals("object", tap.getJSONObject("input_schema").getString("type"))
        val read = DeviceManifest.spec(Cap("screen.read", "Read") { _, _ -> CapResult.text("ok") }, CapabilityPolicies.require("screen.read"))
        assertTrue(!read.has("foreground"))
    }

    @Test fun anEffectTheLinkDoesNotKnowIsRefusedWhereTheManifestIsMade() {
        val cap = Cap("x.y", "d") { _, _ -> CapResult.text("ok") }
        try { DeviceManifest.spec(cap, CapabilityPolicy("none", "send", "l")); throw AssertionError("should refuse") } catch (_: IllegalArgumentException) {}
    }

    @Test fun theDecisionWordsAreForTheKernelOnly() {
        assertEquals(listOf("decision.surface", "decision.screen", "decision.return", "decision.virtual_close"), DeviceManifest.DECISIONS.map { it.getString("name") })
        for (spec in DeviceManifest.DECISIONS) {
            assertNull(spec.getString("name"), codec.capabilityError(spec))
            assertEquals(listOf("kernel"), (0 until spec.getJSONArray("callers").length()).map { spec.getJSONArray("callers").getString(it) })
        }
    }

    @Test fun aManifestFrameWithAllOfItIsValid() {
        val frame = JSONObject().put("t", "manifest").put("ch", "device").put("rev", 1)
            .put("capabilities", org.json.JSONArray(DeviceManifest.DECISIONS)).put("events", org.json.JSONArray(DeviceManifest.EVENTS))
        codec.encode(frame)
    }

    @Test fun everySenseWordTheAppSendsIsDeclared() {
        val sent = Batches.WORDS + SensesEvents.WORDS + setOf("sense.calendar", "sense.battery", "sense.screen", "sense.notification")
        assertEquals(sent, DeviceManifest.EVENT_WORDS)
        for (event in DeviceManifest.EVENTS) {
            val frame = JSONObject().put("t", "event").put("ch", "device").put("id", "e1").put("word", event.getString("word")).put("body", JSONObject()).put("at", 1)
            codec.encode(frame)
        }
    }
}
