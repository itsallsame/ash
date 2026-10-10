package ai.ash.caps

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** What a capability does to the world (the `effect` of the link's CapabilitySpec). */
object Effect {
    const val READ = "read"
    const val WRITE = "write"
    const val ACT = "act"
    const val EXECUTE = "execute"
    val ALL = setOf(READ, WRITE, ACT, EXECUTE)
}

/** How far a call reaches (the `risk` of the link's CapabilitySpec); the kernel's gate decides by it. */
object Risk {
    const val NONE = "none"
    const val OUTWARD = "outward"
    const val STRUCTURE = "structure"
    val ALL = setOf(NONE, OUTWARD, STRUCTURE)
}

/** Who may call a capability (`callers` of the CapabilitySpec). */
object Caller {
    const val OWNER = "owner"
    const val AGENT = "agent"
    const val APP = "app"
    const val KERNEL = "kernel"
}

/**
 * How a call treats Ash's task island while it runs: input that passes through under it, or a capture of the
 * screen it must stay out of. The registry applies this around [Capability.run].
 */
enum class Overlay {
    NONE,
    /** Ash's input to other apps passes under the island, and is refused while the owner is typing. */
    PASSTHROUGH,
    /** A capture of the main screen: the island is taken off for it (a capture of another display needs no such care). */
    HIDDEN,
}

/**
 * One thing the phone can do for ash (and, through ash, for its agents). It declares its own contract (name, schemas,
 * effect, risk, label): the manifest the hand tells the kernel is made from these declarations ([Manifest]), and a test
 * holds them to the standard namespaces of `packages/sdk`.
 *
 * The kernel reads the phone's manifest and calls capabilities over the link's device channel; approvals are enforced
 * by the kernel, so a capability only does its job. Capabilities run on a link worker thread (never the main thread)
 * and may block.
 */
interface Capability {
    /** `<namespace>.<action>` of a standard namespace, or `x.<who>.<action>`, e.g. "screen.tap". */
    val name: String
    /** What it does, written for the model (English; say when it needs a system permission). */
    val description: String
    /** JSON Schema of the arguments (type: object). */
    val schema: JSONObject
    /** JSON Schema of the structured part of the result (`data`), or null when the capability promises none. */
    val result: JSONObject? get() = null
    /** [Effect]. */
    val effect: String
    /** [Risk]. */
    val risk: String
    /** What the owner sees while it runs, in the present continuous ("在点屏幕"). */
    val label: String
    /** The call operates the screen the owner is looking at (the kernel keeps it from running while Ash is in front). */
    val foreground: Boolean get() = false
    /** Who may call it; null = the default (owner, agent and app). */
    val callers: List<String>? get() = null
    val overlay: Overlay get() = Overlay.NONE

    /** Listed in the manifest only when it can work right now (e.g. accessibility enabled). */
    fun available(ctx: Context): Boolean = true

    fun run(ctx: Context, args: JSONObject): CapResult

    /** [run] for a call made in the turn [turn] (empty when it is made outside one); only capabilities that depend on the turn override this. */
    fun run(ctx: Context, args: JSONObject, turn: String): CapResult = run(ctx, args)
}

/** Result in ash's CallResult shape: MCP-style content blocks (+ optional structured data). */
class CapResult private constructor(val ok: Boolean, val content: JSONArray, val data: Any?, val error: String?) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("ok", ok)
        put("content", content)
        if (data != null) put("data", data)
        if (error != null) put("error", error)
    }

    companion object {
        fun text(t: String, data: Any? = null) = CapResult(true, JSONArray().put(JSONObject().put("type", "text").put("text", t)), data, null)

        fun json(data: JSONObject) = text(data.toString(1), data)

        /** An image (e.g. a screenshot, base64 PNG/JPEG) with an optional caption. */
        fun image(base64: String, mime: String, caption: String? = null, data: Any? = null): CapResult {
            val c = JSONArray()
            if (caption != null) c.put(JSONObject().put("type", "text").put("text", caption))
            c.put(JSONObject().put("type", "image").put("data", base64).put("mimeType", mime))
            return CapResult(true, c, data, null)
        }

        /** Text (e.g. a page) followed by an image, with structured data. */
        fun textAndImage(t: String, base64: String, mime: String, data: Any? = null) = CapResult(true, JSONArray()
            .put(JSONObject().put("type", "text").put("text", t))
            .put(JSONObject().put("type", "image").put("data", base64).put("mimeType", mime)), data, null)

        fun fail(msg: String) = CapResult(false, JSONArray().put(JSONObject().put("type", "text").put("text", msg)), null, msg)

        /** A failure with a stable code the caller can act on (e.g. "permission_denied"): the error reads "code: message". */
        fun error(code: String, message: String): CapResult {
            val text = "$code: $message"
            return CapResult(false, JSONArray().put(JSONObject().put("type", "text").put("text", text)),
                JSONObject().put("code", code).put("message", message), text)
        }

        /** A result that crossed the bridge as [toJson]. */
        fun fromJson(o: JSONObject): CapResult = CapResult(o.optBoolean("ok"), o.optJSONArray("content") ?: JSONArray(),
            if (o.has("data")) o.get("data") else null, if (o.has("error")) o.optString("error") else null)
    }
}

/** Tiny schema builder: `schema("x" to prop("string", "…", required = true))`. */
fun schema(vararg props: Pair<String, JSONObject>): JSONObject {
    val properties = JSONObject()
    val required = JSONArray()
    for ((k, v) in props) {
        if (v.optBoolean("__required")) required.put(k)
        v.remove("__required")
        properties.put(k, v)
    }
    return JSONObject().put("type", "object").put("properties", properties).apply { if (required.length() > 0) put("required", required) }
}

fun prop(type: String, description: String, required: Boolean = false, enum: List<String>? = null): JSONObject =
    JSONObject().put("type", type).put("description", description).apply {
        if (required) put("__required", true)
        if (enum != null) put("enum", JSONArray(enum))
    }

/**
 * A result schema from short field specs: "name:type" (a field a hand may leave out) or "name:type!" (always there);
 * a trailing "?" on the type makes it nullable ("value:string?"). Fields beyond the listed ones are allowed.
 */
fun result(vararg fields: String): JSONObject {
    val properties = JSONObject()
    val required = JSONArray()
    for (spec in fields) {
        val name = spec.substringBefore(':')
        var type = spec.substringAfter(':')
        val always = type.endsWith("!")
        if (always) { type = type.dropLast(1); required.put(name) }
        val nullable = type.endsWith("?")
        if (nullable) type = type.dropLast(1)
        properties.put(name, if (nullable) JSONObject().put("anyOf", JSONArray().put(JSONObject().put("type", type)).put(JSONObject().put("type", "null")))
            else JSONObject().put("type", type))
    }
    return JSONObject().put("type", "object").put("additionalProperties", true).put("required", required).put("properties", properties)
}

/** Simple capability from a lambda. */
class Cap(
    override val name: String,
    override val description: String,
    override val schema: JSONObject = schema(),
    private val availableIf: (Context) -> Boolean = { true },
    override val effect: String,
    override val risk: String,
    override val label: String,
    override val result: JSONObject? = null,
    override val foreground: Boolean = false,
    override val callers: List<String>? = null,
    override val overlay: Overlay = Overlay.NONE,
    private val body: (Context, JSONObject) -> CapResult,
) : Capability {
    init {
        require(effect in Effect.ALL) { "$name: unknown effect $effect" }
        require(risk in Risk.ALL) { "$name: unknown risk $risk" }
    }
    override fun available(ctx: Context) = availableIf(ctx)
    override fun run(ctx: Context, args: JSONObject) = body(ctx, args)
}
