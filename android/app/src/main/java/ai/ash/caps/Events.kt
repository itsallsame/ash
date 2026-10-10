package ai.ash.caps

import ai.ash.link.Link
import android.content.Context
import org.json.JSONObject
import java.util.UUID

/**
 * One event this hand sends over the device channel (SPEC-03 §4.3). [schema] is what the body must look like: the one
 * of the standard word (`packages/sdk`), which a test holds this declaration to.
 */
class EventDecl(val word: String, val description: String, schemaJson: String, val durable: Boolean = true) {
    val schema: JSONObject = JSONObject(schemaJson)
}

/**
 * The registry of the hand's events, next to [Capabilities] for its requests. Everything the hand tells the kernel
 * without being asked goes through [emit]: it is queued before it is sent and sent again after a reconnect until the
 * kernel acks it, except the events declared not [EventDecl.durable].
 */
object Events {
    val all: List<EventDecl> = listOf(
        EventDecl(
            "sense.location",
            "New location fixes: {batch_id, items:[{ts, lat, lon, accuracy_m, provider, is_mocked?}]}; the batch id makes a redelivered batch count once.",
            """{"type":"object","properties":{"batch_id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"},"items":{"type":"array","items":{"type":"object","properties":{"ts":{"type":"integer","minimum":0,"maximum":9007199254740991},"lat":{"type":"number","minimum":-90,"maximum":90},"lon":{"type":"number","minimum":-180,"maximum":180},"accuracy_m":{"type":"number","minimum":0,"maximum":1000000},"provider":{"type":"string","minLength":1,"maxLength":32},"is_mocked":{"type":"boolean"}},"required":["ts","lat","lon","accuracy_m","provider"],"additionalProperties":false},"minItems":1,"maxItems":500}},"required":["batch_id","items"],"additionalProperties":false}""",
        ),
        EventDecl(
            "sense.activity",
            "Motion segments: {batch_id, items:[{ts_start, ts_end?, state}]}; a segment is sent again once it has its end.",
            """{"type":"object","properties":{"batch_id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"},"items":{"type":"array","items":{"type":"object","properties":{"ts_start":{"type":"integer","minimum":0,"maximum":9007199254740991},"ts_end":{"type":"integer","minimum":0,"maximum":9007199254740991},"state":{"type":"string","enum":["still","walking","running","cycling","in_vehicle"]}},"required":["ts_start","state"],"additionalProperties":false},"minItems":1,"maxItems":500}},"required":["batch_id","items"],"additionalProperties":false}""",
        ),
        EventDecl(
            "sense.health",
            "Health readings: {batch_id, items:[{ts, metric, value, unit, source}]}.",
            """{"type":"object","properties":{"batch_id":{"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"},"items":{"type":"array","items":{"type":"object","properties":{"ts":{"type":"integer","minimum":0,"maximum":9007199254740991},"metric":{"type":"string","minLength":1,"maxLength":64},"value":{"type":"number"},"unit":{"type":"string","minLength":0,"maxLength":32},"source":{"type":"string","minLength":1,"maxLength":128}},"required":["ts","metric","value","unit","source"],"additionalProperties":false},"minItems":1,"maxItems":500}},"required":["batch_id","items"],"additionalProperties":false}""",
        ),
        EventDecl(
            "sense.geofence",
            "The phone entered or left a named place: {name, transition, ts}.",
            """{"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":64},"transition":{"type":"string","enum":["enter","exit"]},"ts":{"type":"integer","minimum":0,"maximum":9007199254740991}},"required":["name","transition","ts"],"additionalProperties":false}""",
        ),
        EventDecl(
            "sense.source",
            "A health source went stale or came back: {source, state, ts, stale_hours, summary, last_data_ts?}.",
            """{"type":"object","properties":{"source":{"type":"string","minLength":1,"maxLength":64},"state":{"type":"string","enum":["stale","fresh"]},"ts":{"type":"integer","minimum":0,"maximum":9007199254740991},"stale_hours":{"type":"integer","minimum":1,"maximum":720},"summary":{"type":"string","minLength":1,"maxLength":200},"last_data_ts":{"type":"integer","minimum":0,"maximum":9007199254740991}},"required":["source","state","ts","stale_hours","summary"],"additionalProperties":false}""",
        ),
        EventDecl(
            "sense.calendar",
            "A calendar event is coming up or changed: {kind, event}.",
            """{"type":"object","properties":{"kind":{"type":"string","enum":["upcoming","changed"]},"event":{"type":"object","properties":{"id":{"type":"string","minLength":1},"title":{"type":"string"},"start":{"type":"number"},"end":{"type":"number"},"important":{"type":"boolean"}},"required":["id","title","start","end"],"additionalProperties":false}},"required":["kind","event"],"additionalProperties":false}""",
        ),
        EventDecl(
            "sense.battery",
            "The battery is low: {level}.",
            """{"type":"object","properties":{"level":{"type":"number","minimum":0,"maximum":100}},"required":["level"],"additionalProperties":false}""",
        ),
        EventDecl(
            "sense.screen",
            "The owner opened Ash or the screen came on: {state, away_ms}.",
            """{"type":"object","properties":{"state":{"type":"string","enum":["on","app_open"]},"away_ms":{"type":"number","minimum":0}},"required":["state","away_ms"],"additionalProperties":false}""",
        ),
        EventDecl(
            "sense.notification",
            "A notification arrived on the phone: {app, title, text}. Never queued: sent only while the device channel is open, so revoking the read permission leaves no old notification to release later.",
            """{"type":"object","properties":{"app":{"type":"string"},"title":{"type":"string"},"text":{"type":"string"}},"required":["app","title","text"],"additionalProperties":false}""",
            durable = false,
        ),
        EventDecl(
            "widget.placed",
            "Which Ash widgets are on the home screen: {widgets:[{id, type}]}.",
            """{"type":"object","properties":{"widgets":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":12},"type":{"type":"string","enum":["ash","card"]}},"required":["id","type"],"additionalProperties":false},"maxItems":64}},"required":["widgets"],"additionalProperties":false}""",
        ),
        EventDecl(
            "widget.bind",
            "The owner picked which card one placed card widget shows: {widget, card}.",
            """{"type":"object","properties":{"widget":{"type":"string","minLength":1,"maxLength":12},"card":{"type":"string","minLength":1,"maxLength":64,"pattern":"^[a-z0-9][a-z0-9._-]{0,63}$"}},"required":["widget","card"],"additionalProperties":false}""",
        ),
        EventDecl(
            "config.changed",
            "One of the app's own permissions or switches changed: {item, state}; the items are those of config.status.",
            """{"type":"object","properties":{"item":{"type":"string","minLength":1},"state":{"type":"string","minLength":1}},"required":["item","state"],"additionalProperties":false}""",
        ),
    )

    val byWord: Map<String, EventDecl> = all.associateBy { it.word }

    /**
     * Queues the event [word] with [body] for the kernel (see [Link.emit]); the same [id] is the same event, so a retry
     * with it is counted once. Throws for a word this hand did not declare. Returns false only when a non-durable event
     * was dropped because the channel is not open.
     */
    fun emit(ctx: Context, word: String, body: JSONObject, id: String = UUID.randomUUID().toString()): Boolean {
        val decl = requireNotNull(byWord[word]) { "undeclared event $word" }
        return Link.emit(ctx, word, body, id, decl.durable)
    }
}
