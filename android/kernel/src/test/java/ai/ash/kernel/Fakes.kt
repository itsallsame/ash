package ai.ash.kernel

import org.json.JSONObject
import java.io.File
import java.nio.file.Files

/** A JSON Schema checker for the vocabulary host.json's schema uses (draft-07 subset): enough to hold the generator to the real file. */
object MiniSchema {
    fun load(): JSONObject = JSONObject(File(System.getProperty("ash.hostSchema")!!).readText())

    /** Problems found, empty when [value] satisfies [schema]. */
    fun validate(schema: JSONObject, value: Any?, path: String = "$"): List<String> {
        val out = ArrayList<String>()
        if (schema.has("const") && !same(schema.get("const"), value)) out += "$path: expected ${schema.get("const")}"
        schema.optJSONArray("enum")?.let { e -> if ((0 until e.length()).none { same(e.get(it), value) }) out += "$path: $value is not one of $e" }
        if (schema.has("type") && !typeOk(schema.getString("type"), value)) { out += "$path: not a ${schema.getString("type")}"; return out }
        schema.optJSONArray("oneOf")?.let { alts ->
            val matching = (0 until alts.length()).count { validate(alts.getJSONObject(it), value, path).isEmpty() }
            if (matching != 1) out += "$path: matches $matching of ${alts.length()} alternatives"
        }
        if (value is String) {
            if (schema.has("minLength") && value.length < schema.getInt("minLength")) out += "$path: shorter than ${schema.getInt("minLength")}"
            if (schema.has("pattern") && !Regex(schema.getString("pattern")).containsMatchIn(value)) out += "$path: does not match ${schema.getString("pattern")}"
        }
        if (value is JSONObject) {
            schema.optJSONArray("required")?.let { r -> for (i in 0 until r.length()) if (!value.has(r.getString(i))) out += "$path: missing ${r.getString(i)}" }
            schema.optJSONObject("properties")?.let { props ->
                for (k in props.keys()) if (value.has(k)) out += validate(props.getJSONObject(k), value.get(k), "$path.$k")
            }
        }
        if (value is org.json.JSONArray) {
            schema.optJSONObject("items")?.let { item -> for (i in 0 until value.length()) out += validate(item, value.get(i), "$path[$i]") }
            if (schema.optBoolean("uniqueItems") && (0 until value.length()).map { value.get(it).toString() }.let { it.size != it.toSet().size }) out += "$path: items are not unique"
        }
        return out
    }

    private fun same(a: Any?, b: Any?) = a.toString() == b.toString()

    private fun typeOk(type: String, v: Any?) = when (type) {
        "object" -> v is JSONObject
        "array" -> v is org.json.JSONArray
        "string" -> v is String
        "boolean" -> v is Boolean
        "number" -> v is Number
        "integer" -> v is Int || v is Long
        "null" -> v == JSONObject.NULL
        else -> false
    }
}

/** Time that only moves when a test says so. */
class FakeClock(var t: Long = 1_000_000L) : Clock {
    override fun now() = t
    override fun sleep(ms: Long) { t += ms }
    override fun wake() {}
    fun advance(ms: Long) { t += ms }
}

class FakeNode(val startedAt: Long) : NodeHandle {
    var running = true
    val events = ArrayList<String>()
    var stopLine: String? = null
    var stopCalls = 0
    override fun isRunning() = running
    override fun writeEvent(line: String): Boolean { events += line; return running }
    override fun stop(stopLine: String?, graceMs: Long) { stopCalls++; this.stopLine = stopLine; running = false }
}

class FakeLauncher(private val clock: FakeClock) : NodeLauncher {
    val launched = ArrayList<FakeNode>()
    val launchTimes = ArrayList<Long>()
    var failNext = 0
    override fun launch(): NodeHandle {
        if (failNext > 0) { failNext--; throw IllegalStateException("no seal key") }
        launchTimes += clock.now()
        return FakeNode(clock.now()).also { launched += it }
    }
}

class FakeProvisioner : Provisioner {
    var needs = false
    var failures = 0
    var runs = 0
    override fun needsWork() = needs
    override fun run(progress: (String) -> Unit) {
        runs++
        progress("installing")
        if (failures > 0) { failures--; throw java.io.IOException("disk full") }
        needs = false
    }
}

class FakeEnv : EnvSource {
    var proxy: Proxy? = null
    var online = true
    override fun proxy() = proxy
    override fun online() = online
}

class FakeAlarms : AlarmPort {
    val sets = ArrayList<Long>()
    var cancels = 0
    override fun set(atMs: Long) { sets += atMs }
    override fun cancel() { cancels++ }
}

class FakePower : PowerPort {
    val holds = ArrayList<Pair<Long, String>>()
    var releases = 0
    override fun hold(ms: Long, reason: String) { holds += ms to reason }
    override fun release() { releases++ }
}

class FakeHands(var delivered: List<String> = listOf("ai.ash.agent")) : HandsPort {
    val calls = ArrayList<Pair<Int, String>>()
    override fun handoff(port: Int, token: String): List<String> { calls += port to token; return delivered }
}

class FakeCallbacks : HostCallbacks {
    var activity = 0
    val ready = ArrayList<Pair<String, Int>>()
    val restarts = ArrayList<String>()
    val statuses = ArrayList<Pair<String, String>>()
    override fun onActivity() { activity++ }
    override fun onReady(version: String, linkPort: Int) { ready += version to linkPort }
    override fun onRestart(reason: String) { restarts += reason }
    override fun onStatus(text: String, state: String) { statuses += text to state }
}

/** A software key standing in for the Keystore. */
class SoftIdentity : Identity {
    val pair = java.security.KeyPairGenerator.getInstance("EC").apply { initialize(java.security.spec.ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    override fun publicKey(): ByteArray = pair.public.encoded
    override fun sign(data: ByteArray): ByteArray =
        java.security.Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(data); sign() }
}

fun tempDir(prefix: String): File = Files.createTempDirectory(prefix).toFile()
