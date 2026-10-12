// The adb message and pairing-packet formats follow Shizuku (https://github.com/RikkaApps/Shizuku), manager/.../adb/
// AdbMessage.kt, AdbProtocol.kt and AdbPairingClient.kt, Apache License 2.0 (see THIRD_PARTY_NOTICES.md).
// Changes: one small file of pure functions (testable on the JVM); the legacy AUTH constants are left out (TLS only).
package ai.ash.caps.hostshell.adb

import java.io.DataInputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** The wire formats of adb: transport messages, and the pairing packets. No I/O beyond the streams given. */
object AdbWire {
    const val A_CNXN = 0x4e584e43
    const val A_OPEN = 0x4e45504f
    const val A_OKAY = 0x59414b4f
    const val A_CLSE = 0x45534c43
    const val A_WRTE = 0x45545257
    const val A_STLS = 0x534C5453
    const val A_AUTH = 0x48545541
    const val A_VERSION = 0x01000000
    const val A_MAXDATA = 4096
    const val A_STLS_VERSION = 0x01000000
    const val HEADER = 24

    class Message(val command: Int, val arg0: Int, val arg1: Int, val data: ByteArray = ByteArray(0)) {
        override fun toString() = "${name(command)}($arg0, $arg1, ${data.size} bytes)"
    }

    fun name(command: Int): String = when (command) {
        A_CNXN -> "CNXN"; A_OPEN -> "OPEN"; A_OKAY -> "OKAY"; A_CLSE -> "CLSE"; A_WRTE -> "WRTE"; A_STLS -> "STLS"; A_AUTH -> "AUTH"
        else -> "0x" + Integer.toHexString(command)
    }

    /** A string payload as adb sends it: UTF-8 with a closing NUL. */
    fun text(s: String): ByteArray = (s + "\u0000").toByteArray(Charsets.UTF_8)

    /** The sum of the payload's bytes, which adb calls its crc32. */
    fun checksum(data: ByteArray): Int = data.fold(0) { acc, b -> acc + (b.toInt() and 0xff) }

    fun encode(m: Message): ByteArray = ByteBuffer.allocate(HEADER + m.data.size).order(ByteOrder.LITTLE_ENDIAN).apply {
        putInt(m.command); putInt(m.arg0); putInt(m.arg1); putInt(m.data.size); putInt(checksum(m.data)); putInt(m.command.inv())
        put(m.data)
    }.array()

    fun write(out: OutputStream, m: Message) { out.write(encode(m)); out.flush() }

    /** Reads one message; throws on a header that does not hold together (bad magic, a payload over 1 MiB, a wrong sum). */
    fun read(input: DataInputStream): Message {
        val head = ByteArray(HEADER)
        input.readFully(head)
        val b = ByteBuffer.wrap(head).order(ByteOrder.LITTLE_ENDIAN)
        val command = b.int; val arg0 = b.int; val arg1 = b.int; val length = b.int; val sum = b.int; val magic = b.int
        if (magic != command.inv()) throw IllegalStateException("bad adb message (magic)")
        if (length < 0 || length > 1 shl 20) throw IllegalStateException("bad adb message (length $length)")
        val data = ByteArray(length)
        input.readFully(data)
        if (length > 0 && sum != 0 && checksum(data) != sum) throw IllegalStateException("bad adb message (checksum)")
        return Message(command, arg0, arg1, data)
    }

    // ---- pairing packets: [version:1][type:1][size:4 big-endian][payload] ----

    const val PAIRING_VERSION: Byte = 1
    const val SPAKE2_MSG: Byte = 0
    const val PEER_INFO: Byte = 1
    /** A PeerInfo record: one type byte and its data, padded to this size. */
    const val PEER_INFO_SIZE = 8192
    private const val PEER_RSA_PUB_KEY: Byte = 0

    fun packet(type: Byte, payload: ByteArray): ByteArray = ByteBuffer.allocate(6 + payload.size).order(ByteOrder.BIG_ENDIAN).apply {
        put(PAIRING_VERSION); put(type); putInt(payload.size); put(payload)
    }.array()

    /** Reads a pairing packet of [type]; throws on any other version, type or a size out of bounds. */
    fun readPacket(input: DataInputStream, type: Byte): ByteArray {
        val head = ByteArray(6)
        input.readFully(head)
        val b = ByteBuffer.wrap(head).order(ByteOrder.BIG_ENDIAN)
        val version = b.get(); val got = b.get(); val size = b.int
        if (version != PAIRING_VERSION) throw IllegalStateException("pairing version $version is not supported")
        if (got != type) throw IllegalStateException("unexpected pairing packet $got")
        if (size <= 0 || size > PEER_INFO_SIZE * 2) throw IllegalStateException("bad pairing packet size $size")
        return ByteArray(size).also { input.readFully(it) }
    }

    /** Ash's PeerInfo: its adb public key (as [AdbKey.adbPublicKey] writes it), padded. */
    fun peerInfo(adbPublicKey: ByteArray): ByteArray = ByteArray(PEER_INFO_SIZE).also {
        it[0] = PEER_RSA_PUB_KEY
        adbPublicKey.copyInto(it, 1, 0, minOf(adbPublicKey.size, PEER_INFO_SIZE - 1))
    }
}
