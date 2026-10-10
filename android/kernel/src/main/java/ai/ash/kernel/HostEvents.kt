package ai.ash.kernel

import org.json.JSONObject

/** Host events (SPEC-07 section 4): one JSON object per line on the core's standard input. These build the lines. */
object HostEvents {
    fun wakeFired(at: Long): String = JSONObject().put("event", "wake.fired").put("at", at).toString()

    fun networkChanged(proxy: Proxy?, online: Boolean): String =
        JSONObject().put("event", "env.changed").put("what", "network").put("network", networkJson(proxy)).put("online", online).toString()

    fun powerChanged(saver: Boolean): String =
        JSONObject().put("event", "env.changed").put("what", "power").put("saver", saver).toString()

    fun lifecycleStop(deadline: Long, reason: String): String =
        JSONObject().put("event", "lifecycle.stop").put("deadline", deadline).put("reason", reason).toString()
}
