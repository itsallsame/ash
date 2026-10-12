package ai.ash.apps

import ai.ash.human.HumanSend
import android.content.Context
import org.json.JSONObject

/**
 * How her status app's icon in the grid looks: a dot in the corner when she is not simply fine (design/vitals/HANDOFF.md §3, §4). The lamp
 * is worked out here from what the kernel says, by the same rules the app uses: `err` when a behaviour budget is broken now or the
 * kernel cannot be asked, `paused` when the owner paused her, `warn` when one was broken within the last hour or something the phone
 * needs is not done; otherwise `ok`.
 */
object AppLamp {
    /** The app the dot belongs to. */
    const val APP = "vitals"
    private const val HOUR = 3_600_000L

    /**
     * The level from the kernel's answers: [status] is `service:health status` (null: it could not be read), [events] the budget events of
     * the last hour (`service:health recent`, null when unread), [handsTodo] the checkup's count of what the phone still needs (null when unread).
     */
    fun level(paused: Boolean, status: JSONObject?, events: List<JSONObject>?, handsTodo: Int?, now: Long = System.currentTimeMillis()): String {
        if (paused) return "paused"
        if (status == null) return "err"
        val invariants = status.optJSONArray("invariants")
        if (invariants != null && (0 until invariants.length()).any { invariants.optJSONObject(it)?.let { i -> i.has("ok") && !i.optBoolean("ok") } == true }) return "err"
        if (events?.any { it.optString("type") == "breach" && it.optLong("at") >= now - HOUR } == true) return "warn"
        if ((handsTodo ?: 0) > 0) return "warn"
        return "ok"
    }

    /** Asks the kernel and gives the level, or null when it cannot be asked at all. Blocking: not on the main thread. */
    fun read(ctx: Context, now: Long = System.currentTimeMillis()): String? {
        fun data(to: String, word: String, body: JSONObject): JSONObject? = runCatching {
            val sent = HumanSend.send(ctx, JSONObject().put("to", to).put("kind", "request").put("word", word).put("body", body).put("wait", true))
            HumanSend.reply(sent)?.takeIf { it.optBoolean("ok") }?.optJSONObject("result")?.optJSONObject("data")
        }.getOrNull()
        val admin = data("service:admin", "status", JSONObject()) ?: return null
        val status = data("service:health", "status", JSONObject().put("window_s", 60))
        val recent = data("service:health", "recent", JSONObject().put("kind", "event").put("since", now - HOUR).put("limit", 20))
        val events = recent?.optJSONArray("events")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }
        val checkup = data("service:admin", "checkup", JSONObject())
        val todo = checkup?.takeIf { it.optBoolean("known") }?.optJSONArray("groups")?.let { g ->
            (0 until g.length()).sumOf { g.optJSONObject(it)?.takeIf { p -> !p.optBoolean("optional") }?.optInt("todo") ?: 0 }
        }
        return level(admin.optBoolean("paused"), status, events, todo, now)
    }
}
