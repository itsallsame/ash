package ai.ash.link

import okhttp3.mockwebserver.Dispatcher
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.concurrent.CopyOnWriteArrayList

/** The repository's `packages/sdk/schema/link`, found from the module's working directory. */
object Repo {
    val root: File = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
        .first { File(it, "packages/sdk/schema/link/index.json").isFile }
    val schemaDir = File(root, "packages/sdk/schema/link")
    val fixtureDir = File(root, "packages/sdk/fixtures/link")
    val codec: FrameCodec by lazy { FrameCodec.fromDirectory(schemaDir) }
}

/** Waits for a condition that depends on another thread; no fixed sleeps. */
fun awaitTrue(what: String = "condition", timeoutMs: Long = 5_000, check: () -> Boolean) {
    val end = System.nanoTime() + timeoutMs * 1_000_000
    while (!check()) {
        if (System.nanoTime() > end) throw AssertionError("timed out waiting for $what")
        Thread.sleep(3)
    }
}

/** Time that moves only when the test says so. */
class FakeClock : Clock {
    private class Timer(val at: Long, val task: () -> Unit) { @Volatile var cancelled = false }
    private val timers = ArrayList<Timer>()
    @Volatile private var current = 1_000_000L
    /** Every delay ever scheduled, in order. */
    val scheduled = CopyOnWriteArrayList<Long>()

    override fun now(): Long = current

    @Synchronized override fun after(ms: Long, task: () -> Unit): Cancelable {
        val timer = Timer(current + ms, task)
        timers.add(timer)
        scheduled.add(ms)
        return Cancelable { timer.cancelled = true }
    }

    /** Timers waiting, as the time left on each. */
    @Synchronized fun pending(): List<Long> = timers.filter { !it.cancelled }.map { it.at - current }

    fun awaitTimer(ms: Long) = awaitTrue("a timer of $ms ms") { pending().contains(ms) }

    fun advance(ms: Long) {
        val target = current + ms
        while (true) {
            val next = synchronized(this) {
                timers.removeAll { it.cancelled }
                timers.filter { it.at <= target }.minByOrNull { it.at }?.also { timers.remove(it) }
            } ?: break
            current = maxOf(current, next.at)
            next.task()
        }
        current = target
    }
}

/** The kernel's end of one connection. */
class KernelConn(val authorization: String?) {
    @Volatile var socket: WebSocket? = null
    val frames = CopyOnWriteArrayList<JSONObject>()
    @Volatile var closedBy: Int? = null
    var onOpen: (KernelConn) -> Unit = {}

    val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) { socket = webSocket; onOpen(this@KernelConn) }
        override fun onMessage(webSocket: WebSocket, text: String) { frames.add(JSONObject(text)) }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { closedBy = code; webSocket.close(1000, null) }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { if (closedBy == null) closedBy = 1006 }
    }

    fun send(frame: JSONObject) { socket!!.send(frame.toString()) }
    fun sendRaw(text: String) { socket!!.send(text) }
    fun close(code: Int) { socket!!.close(code, "test") }

    fun framesOf(type: String): List<JSONObject> = frames.filter { it.optString("t") == type }
    fun awaitFrame(type: String, nth: Int = 0): JSONObject {
        awaitTrue("a $type frame") { framesOf(type).size > nth }
        return framesOf(type)[nth]
    }

    fun challenge(nonce: String = "nonce-1234", protocol: String = LinkProtocol.NAME) = send(
        JSONObject().put("t", "challenge").put("nonce", nonce).put("kernel", JSONObject().put("id", "kernel-test").put("version", "0.4.0").put("protocol", protocol)),
    )

    fun welcome(device: Boolean = true, human: Boolean = true) {
        val channels = JSONObject()
        if (device) channels.put("device", JSONObject().put("accepted", true)) else channels.put("device", JSONObject().put("accepted", false).put("reason", "no expose_capability"))
        if (human) channels.put("human", JSONObject().put("client", "client:test").put("local", true))
        send(JSONObject().put("t", "welcome").put("hand_id", "hand-test").put("session", "s_1").put("heartbeat_ms", 30000).put("channels", channels))
    }

    fun call(id: String, capability: String = "screen.tap", args: JSONObject = JSONObject(), turn: String? = "t_1") = send(
        JSONObject().put("t", "call").put("ch", "device").put("id", id).put("capability", capability).put("args", args)
            .put("caller", JSONObject().put("member", "agent:main").put("label", "main agent").apply { if (turn != null) put("turn", turn) })
            .put("deadline", 1_760_000_000_000L),
    )
}

/** A kernel on a loopback port (OkHttp's MockWebServer): every WebSocket that opens becomes a [KernelConn]. */
class FakeKernel : AutoCloseable {
    private val server = MockWebServer()
    val conns = CopyOnWriteArrayList<KernelConn>()
    /** What the kernel does when a connection opens; the default is a normal challenge. */
    @Volatile var onOpen: (KernelConn) -> Unit = { it.challenge() }

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val conn = KernelConn(request.getHeader("Authorization"))
                conn.onOpen = { onOpen(it) }
                conns.add(conn)
                return MockResponse().withWebSocketUpgrade(conn.listener)
            }
        }
        server.start()
    }

    val url: String get() = "ws://127.0.0.1:${server.port}/link"

    fun awaitConn(nth: Int = 0): KernelConn {
        awaitTrue("connection $nth") { conns.size > nth && conns[nth].socket != null }
        return conns[nth]
    }

    override fun close() { runCatching { server.shutdown() } }
}

/** Holds the events like a database would: another client built on the same store sees them (a restart of the app). */
class FakeEventStore : EventStore {
    private val rows = java.util.LinkedHashMap<String, QueuedEvent>()
    /** The operations in order, to see that an event is stored before it is sent. */
    val log = CopyOnWriteArrayList<String>()
    @Synchronized override fun add(event: QueuedEvent) { log.add("add ${event.id}"); rows.putIfAbsent(event.id, event) }
    @Synchronized override fun remove(id: String) { log.add("remove $id"); rows.remove(id) }
    @Synchronized override fun pending(): List<QueuedEvent> = rows.values.toList()
    @Synchronized override fun count(): Int = rows.size
    @Synchronized override fun dropOldest(n: Int) { rows.keys.take(n).forEach { rows.remove(it) } }
}

/** A software key standing in for the Keystore. */
class SoftKeyBackend : KeyBackend {
    private val pair = KeyPairGenerator.getInstance("EC").apply { initialize(java.security.spec.ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    override fun publicKeySpki(): ByteArray = pair.public.encoded
    override fun sign(data: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(data); sign() }
    fun verify(data: ByteArray, der: ByteArray): Boolean = Signature.getInstance("SHA256withECDSA").run { initVerify(pair.public); update(data); verify(der) }
}

/** Handlers a test steers. */
class TestHandlers : HandHandlers {
    @Volatile var onCall: (CallRequest, CallContext) -> CallOutcome = { _, _ -> CallOutcome.Ok(listOf(Part.Text("ok"))) }
    @Volatile var onAssess: (String, JSONObject) -> Assessment? = { _, _ -> null }
    val welcomes = java.util.concurrent.atomic.AtomicInteger()
    val closes = CopyOnWriteArrayList<CloseInfo>()
    val acks = CopyOnWriteArrayList<JSONObject>()
    override fun call(call: CallRequest, ctx: CallContext) = onCall(call, ctx)
    override fun assess(capability: String, args: JSONObject) = onAssess(capability, args)
    override fun welcome(welcome: JSONObject) { welcomes.incrementAndGet() }
    override fun closed(info: CloseInfo) { closes.add(info) }
    override fun manifestAck(ack: JSONObject) { acks.add(ack) }
}

/** A client wired to a [FakeKernel] with a fake clock. */
class TestLink(val kernel: FakeKernel = FakeKernel(), val store: FakeEventStore = FakeEventStore()) : AutoCloseable {
    val clock = FakeClock()
    val handlers = TestHandlers()
    val backend = SoftKeyBackend()
    val identity = HandIdentity(backend)
    val outbox = EventOutbox(store)
    @Volatile var token = "test-token"

    val client = LinkClient(
        LinkOptions(
            url = { kernel.url },
            headers = { mapOf("Authorization" to "Bearer $token") },
            hand = HandInfo("phone", "Test phone", "0.4.0", "android-35", identity.publicKey),
            humanLabel = "Test phone chat",
            surfaces = listOf("chat"),
            sign = identity::sign,
            connector = OkHttpConnector(),
            codec = Repo.codec,
            outbox = outbox,
            handlers = handlers,
            clock = clock,
            random = { 0.5 },
            inlineLimit = 1000,
        ),
    )

    /** Connects and completes the handshake with the default welcome. */
    fun connect(device: Boolean = true, human: Boolean = true, nth: Int = 0): KernelConn {
        kernel.onOpen = { it.challenge() }
        if (nth == 0) client.start() else client.reconnectNow()
        val conn = kernel.awaitConn(nth)
        conn.awaitFrame("hello")
        conn.welcome(device, human)
        awaitTrue("ready") { client.state == LinkClient.State.READY }
        return conn
    }

    override fun close() { client.shutdown(); kernel.close() }
}

fun manifestCap(name: String = "screen.tap") = JSONObject().put("name", name).put("description", "d")
    .put("input_schema", JSONObject().put("type", "object")).put("effect", "act").put("risk", "outward")

fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
