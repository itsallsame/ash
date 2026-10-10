package ai.ash.caps

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the device channel's `manifest` says (SPEC-03 §4.1): every capability that can work right now, and the events
 * this hand sends. It is made from the registries ([Capabilities], [Events]); nothing is written down a second time.
 */
object Manifest {
    fun capabilities(ctx: Context): List<JSONObject> = Capabilities.offered(ctx).map(::spec)

    /** One capability as a `CapabilitySpec`. */
    fun spec(c: Capability): JSONObject = JSONObject().put("name", c.name).put("description", c.description).put("label", c.label)
        .put("input_schema", c.schema).put("effect", c.effect).put("risk", c.risk)
        .apply {
            c.result?.let { put("result_schema", it) }
            if (c.foreground) put("foreground", true)
            c.callers?.let { put("callers", JSONArray(it)) }
        }

    /** The events this hand declares; a word not listed here cannot be sent. */
    val events: List<JSONObject> by lazy {
        Events.all.map { JSONObject().put("word", it.word).put("description", it.description).put("schema", it.schema) }
    }
}
