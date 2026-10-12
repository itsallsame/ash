// Adapted from Shizuku (https://github.com/RikkaApps/Shizuku), manager/.../adb/AdbClient.kt and AdbPairingClient.kt,
// Apache License 2.0 (see THIRD_PARTY_NOTICES.md). Changes: TLS only; the keying material through the public
// SSLSockets API (Android 12+) instead of a hidden Conscrypt call; one function each for pairing and for one shell command.
package ai.ash.kernel.host.adb

import android.net.ssl.SSLSockets
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.net.InetSocketAddress
import java.net.Socket
import javax.net.ssl.SSLSocket

/** Thrown when the phone refuses Ash's key: the pairing is gone (removed by the owner, or expired), so pair again. */
class AdbNotPaired(message: String) : Exception(message)

/** Thrown when the pairing code was wrong. */
class AdbWrongCode : Exception("the pairing code did not match")

/** Talks to this phone's own adbd over wireless debugging (127.0.0.1): pairs once, then runs one shell command per connection. */
object AdbClient {
    private const val HOST = "127.0.0.1"
    private const val TIMEOUT_MS = 10_000

    /** Pairs [key] with the phone through the pairing port the owner opened, with the 6-digit [code] they read there. */
    fun pair(port: Int, code: String, key: AdbKey, name: String) {
        Socket().use { raw ->
            raw.connect(InetSocketAddress(HOST, port), TIMEOUT_MS)
            raw.soTimeout = TIMEOUT_MS
            raw.tcpNoDelay = true
            val tls = key.sslContext.socketFactory.createSocket(raw, HOST, port, true) as SSLSocket
            tls.startHandshake()
            val input = DataInputStream(tls.inputStream)
            val output = tls.outputStream
            // The password is the code followed by key material exported from this TLS session, as adb does.
            val material = SSLSockets.exportKeyingMaterial(tls, "adb-label\u0000", null, 64) ?: throw IllegalStateException("no keying material")
            val pairing = PairingNative.create(code.toByteArray() + material)
            if (pairing == 0L) throw IllegalStateException("cannot start the pairing")
            try {
                output.write(AdbWire.packet(AdbWire.SPAKE2_MSG, PairingNative.message(pairing))); output.flush()
                val theirs = AdbWire.readPacket(input, AdbWire.SPAKE2_MSG)
                if (!PairingNative.initCipher(pairing, theirs)) throw AdbWrongCode()
                val sealed = PairingNative.encrypt(pairing, AdbWire.peerInfo(key.adbPublicKey(name))) ?: throw IllegalStateException("cannot seal the key")
                output.write(AdbWire.packet(AdbWire.PEER_INFO, sealed)); output.flush()
                val reply = AdbWire.readPacket(input, AdbWire.PEER_INFO)
                val opened = PairingNative.decrypt(pairing, reply) ?: throw AdbWrongCode()
                if (opened.size != AdbWire.PEER_INFO_SIZE) throw IllegalStateException("unexpected pairing reply")
            } finally {
                PairingNative.destroy(pairing)
            }
        }
    }

    /** Connects to wireless debugging on [port] with [key] and runs one `shell:` [command]; returns what it printed. */
    fun shell(port: Int, key: AdbKey, command: String): String {
        Socket().use { raw ->
            raw.connect(InetSocketAddress(HOST, port), TIMEOUT_MS)
            raw.soTimeout = TIMEOUT_MS
            raw.tcpNoDelay = true
            AdbWire.write(raw.getOutputStream(), AdbWire.Message(AdbWire.A_CNXN, AdbWire.A_VERSION, AdbWire.A_MAXDATA, AdbWire.text("host::")))
            val first = AdbWire.read(DataInputStream(raw.getInputStream()))
            if (first.command != AdbWire.A_STLS) throw IllegalStateException("wireless debugging did not offer TLS (${AdbWire.name(first.command)})")
            AdbWire.write(raw.getOutputStream(), AdbWire.Message(AdbWire.A_STLS, AdbWire.A_STLS_VERSION, 0))
            val tls = key.sslContext.socketFactory.createSocket(raw, HOST, port, true) as SSLSocket
            try {
                tls.startHandshake()
            } catch (e: Exception) {
                throw AdbNotPaired("the phone did not accept Ash's key (${e.javaClass.simpleName})")
            }
            val input = DataInputStream(tls.inputStream)
            val output = tls.outputStream
            val hello = try { AdbWire.read(input) } catch (e: Exception) { throw AdbNotPaired("the phone closed the connection (${e.javaClass.simpleName})") }
            if (hello.command != AdbWire.A_CNXN) throw IllegalStateException("unexpected ${AdbWire.name(hello.command)} after TLS")
            val local = 1
            AdbWire.write(output, AdbWire.Message(AdbWire.A_OPEN, local, 0, AdbWire.text("shell:$command")))
            val out = ByteArrayOutputStream()
            while (true) {
                val m = AdbWire.read(input)
                when (m.command) {
                    AdbWire.A_OKAY -> {}
                    AdbWire.A_WRTE -> {
                        if (out.size() < 64_000) out.write(m.data)
                        AdbWire.write(output, AdbWire.Message(AdbWire.A_OKAY, local, m.arg0))
                    }
                    AdbWire.A_CLSE -> {
                        AdbWire.write(output, AdbWire.Message(AdbWire.A_CLSE, local, m.arg0))
                        return out.toString("UTF-8")
                    }
                    else -> throw IllegalStateException("unexpected ${AdbWire.name(m.command)}")
                }
            }
        }
    }
}

/** BoringSSL's SPAKE2 and the pairing cipher (src/main/jni/adb_pairing.c). */
object PairingNative {
    init { System.loadLibrary("ashadb") }
    @JvmStatic external fun create(password: ByteArray): Long
    @JvmStatic external fun message(ptr: Long): ByteArray
    @JvmStatic external fun initCipher(ptr: Long, theirs: ByteArray): Boolean
    @JvmStatic external fun encrypt(ptr: Long, input: ByteArray): ByteArray?
    @JvmStatic external fun decrypt(ptr: Long, input: ByteArray): ByteArray?
    @JvmStatic external fun destroy(ptr: Long)
}
