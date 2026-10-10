package ai.ash.host.cap

import ai.ash.senses.SenseCapabilities
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * The senses tools are only offered with a policy of Ash's: every one has one. Recording is the owner's
 * routine (turning it on, changing places, syncing the watch) and needs no approval; only deleting records does.
 */
class SensesPolicyTest {
    private val writes = setOf("location.track", "sense.configure", "sense.delete", "health.sync")
    /** Every tool the senses offer: Ash keeps a policy for each (a tool without one is never offered). */
    private val sensesTools = listOf(
        "location.get", "location.track", "location.history", "activity.current", "activity.history", "sensors.steps",
        "health.sources", "health.read", "health.summary", "health.sync", "sense.status", "sense.configure", "sense.delete",
    )

    @Test fun everyToolIsListedForAshsPolicies() {
        assertEquals(sensesTools, SenseCapabilities.list.map { it.name })
    }

    @Test fun everySensesToolHasAPolicy() {
        for (name in sensesTools) assertNotNull(name, CapabilityPolicies.byName[name])
    }

    @Test fun readsNeedNoApproval() {
        for (name in sensesTools - writes) {
            val p = CapabilityPolicies.require(name)
            assertEquals(name, "none", p.risk)
            assertEquals(name, "read", p.effect)
        }
    }

    @Test fun recordingNeedsNoApprovalButDeletingDoes() {
        for (name in listOf("location.track", "sense.configure", "health.sync")) assertEquals(name, "none", CapabilityPolicies.require(name).risk)
        assertNotEquals("none", CapabilityPolicies.require("sense.delete").risk)
        assertEquals("write", CapabilityPolicies.require("sense.configure").effect)
        assertEquals("write", CapabilityPolicies.require("sense.delete").effect)
        assertEquals("write", CapabilityPolicies.require("location.track").effect)
        assertEquals("act", CapabilityPolicies.require("health.sync").effect)
    }
}
