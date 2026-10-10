package ai.ash.link

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.net.Proxy
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Time as the link sees it. Everything with a timeout takes a Clock, so a test moves time without waiting. */
interface Clock {
    fun now(): Long
    /** Runs [task] once, after [ms], on any thread. */
    fun after(ms: Long, task: () -> Unit): Cancelable
}

fun interface Cancelable { fun cancel() }

object SystemClock : Clock {
    private val timer: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "ash-link-timer").apply { isDaemon = true } }
    override fun now(): Long = System.currentTimeMillis()
    override fun after(ms: Long, task: () -> Unit): Cancelable {
        val future: ScheduledFuture<*> = timer.schedule({ runCatching(task) }, ms, TimeUnit.MILLISECONDS)
        return Cancelable { future.cancel(false) }
    }
}

/** The sending half of one open WebSocket; the events come through [SocketListener]. */
interface LinkSocket {
    /** Queues a text message; false when the socket is closed or cannot take it. */
    fun send(text: String): Boolean
    /** Bytes queued and not yet written; a sender of large streams waits for this to drain. */
    fun queueSize(): Long
    fun close(code: Int, reason: String)
    /** Drops the connection without waiting for the peer (a peer gone silent never answers a close). */
    fun cancel()
}

interface SocketListener {
    /** A text message; [text] is null for a binary one (which the protocol does not allow). */
    fun onMessage(text: String?)
    /** The connection ended: the peer closed it, or the network failed (code 1006). Called at most once per socket. */
    fun onClosed(code: Int, reason: String)
}

fun interface SocketConnector {
    fun connect(url: String, headers: Map<String, String>, listener: SocketListener): LinkSocket
}

/** OkHttp underneath. Loopback only: no proxy, no read timeout (the link has its own heartbeat and silence limit). */
class OkHttpConnector(client: OkHttpClient? = null) : SocketConnector {
    private val http: OkHttpClient = client ?: OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(0, TimeUnit.MILLISECONDS)
        .build()

    override fun connect(url: String, headers: Map<String, String>, listener: SocketListener): LinkSocket {
        val request = Request.Builder().url(url).apply { headers.forEach { (k, v) -> header(k, v) } }.build()
        val done = java.util.concurrent.atomic.AtomicBoolean(false)
        val closed = { code: Int, reason: String -> if (done.compareAndSet(false, true)) listener.onClosed(code, reason) }
        val socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(text)
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) = listener.onMessage(null)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                // The peer started the close: tell the link now, and finish the handshake.
                closed(code, reason)
                webSocket.close(if (code in 1000..1003 || code in 1007..1011 || code in 3000..4999) code else 1000, null)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = closed(code, reason)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                closed(1006, (t.message ?: t.javaClass.simpleName).take(100))
        })
        return object : LinkSocket {
            override fun send(text: String): Boolean = socket.send(text)
            override fun queueSize(): Long = socket.queueSize()
            override fun close(code: Int, reason: String) { socket.close(code, reason) }
            override fun cancel() { socket.cancel() }
        }
    }
}
