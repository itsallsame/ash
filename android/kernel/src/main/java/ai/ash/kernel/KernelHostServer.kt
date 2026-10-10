package ai.ash.kernel

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * The transport of the host interface: a loopback HTTP/1.1 server (127.0.0.1, random port). Other apps on the phone can
 * reach loopback ports, so every request is checked against the host token by [HostApi]. Nothing is logged but failures.
 */
class KernelHostServer(private val api: HostApi, private val log: (String) -> Unit = {}) {
    private val pool = Executors.newCachedThreadPool()
    private var server: ServerSocket? = null

    var port = 0
        private set

    val endpoint: String get() = "http://127.0.0.1:$port"

    fun start(): Int {
        val s = ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"))
        server = s
        port = s.localPort
        pool.execute {
            while (!s.isClosed) {
                val c = try { s.accept() } catch (_: IOException) { break }
                try {
                    pool.execute {
                        try { serve(c) } catch (_: IOException) { /* a client that went away is normal */ }
                        catch (e: Throwable) { log("host request failed: ${e.javaClass.simpleName}") }
                    }
                } catch (_: RejectedExecutionException) {
                    try { c.close() } catch (_: IOException) {}
                }
            }
        }
        return port
    }

    fun stop() {
        try { server?.close() } catch (_: IOException) {}
        pool.shutdownNow()
    }

    private fun serve(sock: Socket) {
        sock.use { s ->
            s.soTimeout = 30_000
            val input = BufferedInputStream(s.getInputStream())
            val requestLine = readLine(input) ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val headers = HashMap<String, String>()
            while (true) {
                val l = readLine(input) ?: return
                if (l.isEmpty()) break
                val i = l.indexOf(':')
                if (i > 0) headers[l.substring(0, i).trim().lowercase()] = l.substring(i + 1).trim()
            }
            val len = headers["content-length"]?.toIntOrNull() ?: 0
            if (len > MAX_BODY) return respond(s, Reply(413, error("too_large", "body too large")))
            val body = if (len > 0) readN(input, len) else ByteArray(0)
            respond(s, api.handle(parts[0], parts[1], headers["authorization"], body))
        }
    }

    private fun error(code: String, message: String) =
        JSONObject().put("ok", false).put("error", JSONObject().put("code", code).put("message", message))

    private fun respond(s: Socket, r: Reply) {
        val bytes = r.body.toString().toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 ${r.status} ${if (r.status == 200) "OK" else "Error"}\r\ncontent-type: application/json; charset=utf-8\r\n" +
            "content-length: ${bytes.size}\r\nconnection: close\r\n\r\n"
        s.getOutputStream().apply { write(head.toByteArray()); write(bytes); flush() }
    }

    private fun readLine(i: InputStream): String? {
        val b = ByteArrayOutputStream()
        while (true) {
            val c = i.read()
            if (c < 0) return if (b.size() == 0) null else b.toString("UTF-8")
            if (c == '\n'.code) return b.toString("UTF-8").trimEnd('\r')
            b.write(c)
            if (b.size() > 16 * 1024) return null
        }
    }

    private fun readN(i: InputStream, n: Int): ByteArray {
        val out = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = i.read(out, off, n - off)
            if (r < 0) break
            off += r
        }
        return out
    }

    private companion object { const val MAX_BODY = 1024 * 1024 }
}
