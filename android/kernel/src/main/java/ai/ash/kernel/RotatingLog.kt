package ai.ash.kernel

import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * The core's standard output and error, and the host's own notes, in one file: `name`, `name.1`, `name.2` ...
 * When the current file passes [maxBytes] it becomes `name.1` (older ones shift up, the oldest is dropped); [keep] files in all.
 */
class RotatingLog(
    private val dir: File,
    private val name: String = "core.log",
    private val maxBytes: Long = 5L * 1024 * 1024,
    private val keep: Int = 3,
) {
    private var out: FileOutputStream? = null
    private var size = 0L

    private val file get() = File(dir, name)

    @Synchronized
    fun write(buf: ByteArray, off: Int = 0, len: Int = buf.size) {
        val o = open() ?: return
        try {
            o.write(buf, off, len)
            size += len
            if (size >= maxBytes) rotate()
        } catch (_: java.io.IOException) {
            close()
        }
    }

    /** A line from the host itself ("[host] ..."), so one file tells the whole story. */
    fun note(msg: String) {
        val stamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
        write("$stamp [host] $msg\n".toByteArray(Charsets.UTF_8))
    }

    @Synchronized
    fun close() {
        try { out?.close() } catch (_: java.io.IOException) {}
        out = null
    }

    private fun open(): FileOutputStream? {
        out?.let { return it }
        return try {
            dir.mkdirs()
            size = file.length()
            FileOutputStream(file, true).also { out = it }
        } catch (_: java.io.IOException) {
            null
        }
    }

    private fun rotate() {
        close()
        File(dir, "$name.${keep - 1}").delete()
        for (i in keep - 2 downTo 1) File(dir, "$name.$i").renameTo(File(dir, "$name.${i + 1}"))
        if (keep > 1) file.renameTo(File(dir, "$name.1")) else file.delete()
        size = 0
    }
}
