package ai.ash.link

import ai.ash.BuildConfig
import ai.ash.caps.Capabilities
import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import ai.ash.caps.DeviceCalls
import ai.ash.caps.DeviceManifest

/**
 * The app's one connection to the kernel (SPEC-05 §4): the process-wide [LinkClient], with the phone's identity, event
 * queue and capabilities behind it. Events can be queued before there is a connection; the kernel host's `attach`
 * (see [HandService]) is what starts connecting.
 */
object Link {
    private const val TAG = "ash.link"
    @Volatile private var runtime: Runtime? = null

    @Synchronized fun get(ctx: Context): Runtime = runtime ?: Runtime(ctx.applicationContext).also { runtime = it }

    /** Queues a device event (a `sense.*` word, ...) for the kernel; see [LinkClient.emit]. */
    fun emit(ctx: Context, word: String, body: JSONObject, id: String, durable: Boolean = true): Boolean =
        get(ctx).client.emit(word, body, id, durable = durable)

    /** The capabilities changed (an accessibility service came or went): the kernel is told if the manifest differs now. */
    fun manifestChanged() { runtime?.refreshSoon() }

    /** One line for the diagnostics page; says nothing of the port or the token. */
    fun describe(): String {
        val r = runtime ?: return "未启动"
        val c = r.client
        return when (c.state) {
            LinkClient.State.READY -> "已连接内核"
            LinkClient.State.STOPPED -> "已停止（关闭码 ${c.stoppedBy ?: "-"}）"
            LinkClient.State.IDLE -> "等待内核交接"
            else -> "连接中" + (c.lastClose?.let { "（上次关闭码 ${it.code}）" } ?: "")
        }
    }

    class Runtime(private val ctx: Context) {
        private class Endpoint(val port: Int, val token: String)
        @Volatile private var endpoint: Endpoint? = null
        @Volatile private var lastManifest = ""
        private val identity = HandIdentity(KeystoreKeyBackend())
        private val refresher = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "ash-link-manifest").apply { isDaemon = true } }
        private val calls = DeviceCalls(ctx)

        val client: LinkClient = LinkClient(
            LinkOptions(
                url = { "ws://127.0.0.1:${requireNotNull(endpoint) { "the kernel host has not attached yet" }.port}/link" },
                headers = { mapOf("Authorization" to "Bearer ${requireNotNull(endpoint).token}") },
                hand = HandInfo("phone", Capabilities.deviceName(), BuildConfig.VERSION_NAME, "android-${Build.VERSION.SDK_INT}", identity.publicKey),
                humanLabel = "手机 · 对话",
                // TODO(T11b-2): list "chat", "notification", "island", "widget", "status" once the human channel shows them.
                surfaces = emptyList(),
                sign = identity::sign,
                connector = OkHttpConnector(),
                codec = FrameCodec { name -> ctx.assets.open("link-schema/$name").use { it.readBytes().toString(Charsets.UTF_8) } },
                outbox = EventOutbox(SqliteEventStore(ctx)),
                handlers = calls,
            ),
        )

        init { refresher.scheduleWithFixedDelay({ runCatching { refresh() } }, 60, 60, TimeUnit.SECONDS) }

        /** The kernel host handed over a port and a token (again): connect now. The token stays in memory, never in a log. */
        fun attach(port: Int, token: String, kernelVersion: String) {
            require(port in 1..65535) { "bad port" }
            require(token.isNotEmpty()) { "empty token" }
            Log.i(TAG, "kernel host attached (kernel $kernelVersion)")
            endpoint = Endpoint(port, token)
            refresh()
            client.reconnectNow()
        }

        fun refreshSoon() { runCatching { refresher.execute { runCatching { refresh() } } } }

        /** Tells the client the manifest when the capabilities that work now are not the ones it holds. */
        @Synchronized private fun refresh() {
            val capabilities = DeviceManifest.capabilities(ctx)
            val key = capabilities.joinToString("\n") { it.toString() }
            if (key == lastManifest) return
            lastManifest = key
            client.setManifest(capabilities, DeviceManifest.EVENTS)
        }
    }
}
