package ai.ash.kernel

import org.json.JSONException
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The host's end of the core's private pipe (`ash-host/1`): the core's own standard input and output, which only the host
 * that started it holds. No port, no token. The secrets go first ([bootLine]); after that each line the core writes is a
 * call (`{"call":id,"method":…,"params":…}`) answered on its standard input (`{"reply":id,"ok":…}`), and host events are
 * written there too. A slow call (a virtual-screen screenshot) does not hold up the others.
 */
class HostPipe(private val api: HostApi, private val log: (String) -> Unit = {}) {
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "ash-host-call").apply { isDaemon = true } }

    /** One line the core wrote on its standard output. Anything that is not a call is the core's to log, not ours to obey. */
    fun take(node: NodeHandle, line: String) {
        val call = try { JSONObject(line) } catch (_: JSONException) { null }
        val id = call?.opt("call")
        val method = call?.opt("method")
        if (id !is Int || method !is String) {
            if (line.isNotBlank()) log("core stdout: ${line.take(200)}")
            return
        }
        val params = call.optJSONObject("params") ?: JSONObject()
        pool.execute { node.writeEvent(api.call(method, params).put("reply", id).toString()) }
    }

    companion object {
        /** The first line on the core's standard input: the vault's seal key (base64url). */
        fun bootLine(sealKey: String): String = JSONObject().put("boot", JSONObject().put("seal_key", sealKey)).toString()
    }
}
