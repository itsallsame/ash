package ai.ash.caps

import ai.ash.caps.Capabilities
import ai.ash.caps.Capability
import ai.ash.caps.CapabilityPolicy
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the device channel's `manifest` says (SPEC-03 §4.1): every capability that can work right now, and the events
 * this hand sends. Made from the capability registry ([Capabilities]) and Ash's policies; the capability names are
 * the current ones (moving them into the standard namespaces is a later step).
 */
object DeviceManifest {
    /** `effect` values the protocol knows; the policy table must stay inside them. */
    val EFFECTS = setOf("read", "write", "act", "execute")

    /** Capabilities that operate the screen the owner is looking at (the kernel keeps them from running while Ash is in front). */
    val FOREGROUND = setOf(
        "screen.tap", "screen.type", "screen.scroll", "screen.swipe", "screen.hold", "screen.touch", "screen.gesture", "screen.global_action",
        "input.key", "apps.open", "settings.open", "intent.view",
    )

    /** The words of the decision service, which only the kernel may call (they were routes of the old host bridge). */
    val DECISIONS: List<JSONObject> = listOf(
        decision("decision.surface", "Starts a decision turn and tells whether Ash is in front of the owner, and whether a virtual screen is possible.", "act",
            mapOf("turn" to "string")),
        decision("decision.screen", "The foreground app, the screen's change counter and the virtual screen's state, for a decision.", "read", emptyMap()),
        decision("decision.return", "Brings Ash back to the front if the screen is still as the decision saw it.", "act",
            mapOf("decision_id" to "string", "turn" to "string", "expected_state_epoch" to "integer", "expected_package" to "string")),
        decision("decision.virtual_close", "Closes the virtual screen if it is still the one the decision saw.", "act",
            mapOf("decision_id" to "string", "owner_turn" to "string", "expected_generation" to "integer")),
    )

    /** The events this hand declares (SPEC-03 §4.3); a word not listed here cannot be sent. */
    val EVENTS: List<JSONObject> = listOf(
        event("sense.location", "New location fixes: {batch_id, items:[{ts, lat, lon, accuracy_m, provider, is_mocked?}]}."),
        event("sense.activity", "Motion segments: {batch_id, items:[{ts_start, ts_end?, state}]}."),
        event("sense.health", "Health readings: {batch_id, items:[{ts, metric, value, unit, source}]}."),
        event("sense.geofence", "The phone entered or left a named place: {name, transition, ts}."),
        event("sense.source", "A health source went stale or came back: {source, state, ts, stale_hours, summary, last_data_ts?}."),
        event("sense.calendar", "A calendar event is coming up or changed: {kind, event}."),
        event("sense.battery", "The battery is low: {level}."),
        event("sense.screen", "The owner opened Ash or the screen came on: {state, away_ms}."),
        event("sense.notification", "A notification arrived on the phone: {app, title, text}."),
    )

    /** The words the app sends as events; the kernel routes `sense.*` to the senses service. */
    val EVENT_WORDS: Set<String> = EVENTS.map { it.getString("word") }.toSet()

    fun capabilities(ctx: Context): List<JSONObject> =
        Capabilities.offered(ctx).map { (cap, policy) -> spec(cap, policy) } + DECISIONS

    /** One capability as a `CapabilitySpec`. */
    fun spec(cap: Capability, policy: CapabilityPolicy): JSONObject {
        require(policy.effect in EFFECTS) { "${cap.name}: effect ${policy.effect} is not an effect of the link" }
        return JSONObject().put("name", cap.name).put("description", cap.description).put("input_schema", cap.schema)
            .put("effect", policy.effect).put("risk", policy.risk).put("label", policy.label)
            .apply { if (cap.name in FOREGROUND) put("foreground", true) }
    }

    private fun decision(name: String, description: String, effect: String, args: Map<String, String>): JSONObject {
        val properties = JSONObject().apply { args.forEach { (k, type) -> put(k, JSONObject().put("type", type)) } }
        return JSONObject().put("name", name).put("description", description).put("label", "判断是否回到 Ash")
            .put("input_schema", JSONObject().put("type", "object").put("properties", properties))
            .put("effect", effect).put("risk", "none").put("callers", JSONArray().put("kernel"))
    }

    private fun event(word: String, description: String) = JSONObject().put("word", word).put("description", description)
}
