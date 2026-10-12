package ai.ash.ui

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.MimeTypeMap
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream

/**
 * What the owner picked, as the `attachments` of a `say` body — the same rules as the web page's attachments.js: files and
 * animations are kept as they are; a still picture is shrunk (longest side 2048, JPEG 85) only when that makes it smaller;
 * one file is at most about 3 MB (a message travels in one 4 MiB frame, base64 adds a third).
 * Everything here reads and encodes: call it off the main thread.
 */
object Uploads {
    /** The longest file the page will open from a message. */
    const val MAX_FILE_BYTES = 20 * 1024 * 1024
    /** A file to send is about 3 MB or less (the frame holds 4 MiB, and base64 adds a third). */
    const val MAX_SEND_BYTES = 3 * 1024 * 1024
    /** The most a source file may weigh before it is even looked at. */
    const val MAX_SOURCE_BYTES = 80L * 1024 * 1024
    const val MAX_ATTACHMENTS = 32
    /** A frame is at most 4 MiB (SPEC-03 §1); the wire message of a say has to fit in one with room for the envelope. */
    const val MAX_WIRE_BYTES = 4 * 1024 * 1024 - 8 * 1024
    private const val LONGEST_SIDE = 2048
    private const val JPEG_QUALITY = 85

    private val COMPACTABLE = setOf("image/png", "image/jpeg", "image/webp", "image/heic", "image/heif", "image/bmp")

    /** One file, ready to send, or why not (in words for the owner). */
    sealed class Result {
        class Ok(val attachment: JSONObject) : Result()
        class Refused(val why: String) : Result()
    }

    fun safeName(name: String?): String {
        val cleaned = name.orEmpty().map { if (it == '\\' || it == '/' || it.code < 32 || it.code == 127) '_' else it }.joinToString("")
        return cleaned.codePoints().limit(180).toArray().let { String(it, 0, it.size) }.ifEmpty { "attachment" }
    }

    fun rasterBytes(type: String, b: ByteArray): Boolean = when (type) {
        "image/png" -> b.size >= 8 && intArrayOf(137, 80, 78, 71, 13, 10, 26, 10).withIndex().all { (i, v) -> (b[i].toInt() and 0xFF) == v }
        "image/jpeg" -> b.size >= 3 && (b[0].toInt() and 0xFF) == 255 && (b[1].toInt() and 0xFF) == 216 && (b[2].toInt() and 0xFF) == 255
        "image/gif" -> b.size >= 6 && String(b, 0, 6, Charsets.ISO_8859_1).let { it == "GIF87a" || it == "GIF89a" }
        "image/webp" -> b.size >= 12 && String(b, 0, 4, Charsets.ISO_8859_1) == "RIFF" && String(b, 8, 4, Charsets.ISO_8859_1) == "WEBP"
        "image/bmp" -> b.size >= 2 && b[0].toInt() == 66 && b[1].toInt() == 77
        "image/heic", "image/heif" -> b.size >= 12 && String(b, 4, 4, Charsets.ISO_8859_1) == "ftyp"
        else -> false
    }

    /** The size the say would have on the wire (JSON text, like the page counts it): false when it would not fit in a frame. */
    fun fits(text: String, attachments: JSONArray): Boolean = wireBytes(text, attachments) <= MAX_WIRE_BYTES

    fun wireBytes(text: String, attachments: JSONArray): Int {
        val body = JSONObject().put("text", text)
        if (attachments.length() > 0) body.put("attachments", attachments)
        val wire = JSONObject().put("to", "agent:placeholder").put("kind", "request").put("word", "say").put("body", body).put("client_id", "0".repeat(36))
        // org.json writes "/" as "\/" (base64 has plenty); JSON text for the wire does not.
        return wire.toString().replace("\\/", "/").toByteArray(Charsets.UTF_8).size
    }

    /** Reads the chosen file (a content URI) as an attachment. */
    fun prepare(resolver: ContentResolver, uri: Uri): Result {
        val shown = nameOf(resolver, uri)
        try {
            val size = sizeOf(resolver, uri)
            if (size > MAX_SOURCE_BYTES) return Result.Refused("附件太大（$shown）：一条消息最多带约 3 MB")
            val type = (resolver.getType(uri) ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(shown.substringAfterLast('.', "").lowercase()))
                ?.lowercase()?.takeIf { it.matches(Regex("[a-z0-9.+-]+/[a-z0-9.+*-]+")) } ?: "application/octet-stream"
            val head = resolver.openInputStream(uri)?.use { readUpTo(it, 16) } ?: return Result.Refused("读不了这个文件（$shown）")
            var name = shown
            var mime = type
            var bytes: ByteArray? = null
            if (type in COMPACTABLE && rasterBytes(type, head)) {
                val shrunk = runCatching { shrink(resolver, uri) }.getOrNull()
                if (shrunk != null && shrunk.isNotEmpty() && (size < 0 || shrunk.size < size)) {
                    bytes = shrunk; mime = "image/jpeg"; name = shown.replace(Regex("\\.[^./\\\\]+$"), "").ifEmpty { "image" } + ".jpg"
                }
            }
            if (bytes == null) {
                if (size > MAX_SEND_BYTES) return Result.Refused("附件太大（$shown）：一条消息最多带约 3 MB")
                bytes = resolver.openInputStream(uri)?.use { readUpTo(it, MAX_SEND_BYTES + 1) } ?: return Result.Refused("读不了这个文件（$shown）")
            }
            if (bytes.isEmpty()) return Result.Refused("这个文件是空的（$shown）")
            if (bytes.size > MAX_SEND_BYTES) return Result.Refused("附件太大（$shown）：一条消息最多带约 3 MB")
            return Result.Ok(JSONObject().put("name", safeName(name)).put("mime_type", mime).put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)))
        } catch (e: Exception) {
            return Result.Refused("读不了这个文件（$shown）")
        }
    }

    private fun nameOf(resolver: ContentResolver, uri: Uri): String {
        val fromProvider = runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
        }.getOrNull()
        return fromProvider?.takeIf { it.isNotBlank() } ?: uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "attachment"
    }

    /** The file's size in bytes, or -1 when its provider does not say. */
    private fun sizeOf(resolver: ContentResolver, uri: Uri): Long {
        val q = runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else -1L }
        }.getOrNull() ?: -1L
        if (q >= 0) return q
        return runCatching { resolver.openAssetFileDescriptor(uri, "r")?.use { it.length } }.getOrNull() ?: -1L
    }

    private fun readUpTo(input: InputStream, limit: Int): ByteArray {
        val out = ByteArrayOutputStream(minOf(limit, 64 * 1024))
        val buf = ByteArray(16 * 1024)
        while (out.size() < limit) {
            val n = input.read(buf, 0, minOf(buf.size, limit - out.size()))
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    /** A still picture in its right way up, at most [LONGEST_SIDE] on the long side, on white, as JPEG; null when it cannot be read. */
    private fun shrink(resolver: ContentResolver, uri: Uri): ByteArray? {
        val picture = if (Build.VERSION.SDK_INT >= 28) decodeScaled(resolver, uri) else decodeLegacy(resolver, uri)
        picture ?: return null
        val flat = Bitmap.createBitmap(picture.width, picture.height, Bitmap.Config.ARGB_8888)
        Canvas(flat).apply { drawColor(Color.WHITE); drawBitmap(picture, 0f, 0f, null) }
        if (picture !== flat) picture.recycle()
        val out = ByteArrayOutputStream()
        val ok = flat.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
        flat.recycle()
        return if (ok) out.toByteArray() else null
    }

    @android.annotation.SuppressLint("NewApi")
    private fun decodeScaled(resolver: ContentResolver, uri: Uri): Bitmap? =
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            val w = info.size.width; val h = info.size.height
            if (w < 1 || h < 1 || w > 32768 || h > 32768) throw IllegalArgumentException("image dimensions unsupported")
            val scale = minOf(1f, LONGEST_SIDE / maxOf(w, h).toFloat())
            if (scale < 1f) decoder.setTargetSize(maxOf(1, Math.round(w * scale)), maxOf(1, Math.round(h * scale)))
        }

    /** Before API 28: BitmapFactory decodes smaller by whole steps, then the EXIF turn is applied by hand. */
    private fun decodeLegacy(resolver: ContentResolver, uri: Uri): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        val w = bounds.outWidth; val h = bounds.outHeight
        if (w < 1 || h < 1 || w > 32768 || h > 32768) return null
        var sample = 1
        while (maxOf(w, h) / (sample * 2) >= LONGEST_SIDE) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        val raw = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null
        val scale = minOf(1f, LONGEST_SIDE / maxOf(raw.width, raw.height).toFloat())
        val turn = when (resolver.openInputStream(uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f; ExifInterface.ORIENTATION_ROTATE_180 -> 180f; ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
        if (scale >= 1f && turn == 0f) return raw
        val m = Matrix().apply { postScale(scale, scale); if (turn != 0f) postRotate(turn) }
        return Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, m, true).also { if (it !== raw) raw.recycle() }
    }

    /** An attachment as the ledger carries it, checked: [preview] says the bytes are really a still picture the page may show. */
    class Decoded(val bytes: ByteArray, val mime: String, val preview: Boolean)

    private val RASTER = setOf("image/png", "image/jpeg", "image/webp", "image/gif")

    /** The base64 text of an inline attachment, strictly: null when it is not canonical base64 or is longer than [MAX_FILE_BYTES]. */
    fun decodeInline(b64: String, declaredMime: String): Decoded? {
        if (b64.isEmpty() || b64.length % 4 != 0 || b64.length > (MAX_FILE_BYTES + 2) / 3 * 4 + 4 || !Regex("[A-Za-z0-9+/]+={0,2}").matches(b64)) return null
        val bytes = runCatching { java.util.Base64.getDecoder().decode(b64) }.getOrNull() ?: return null
        if (bytes.size > MAX_FILE_BYTES || java.util.Base64.getEncoder().encodeToString(bytes) != b64) return null
        val mime = declaredMime.lowercase()
        val preview = mime in RASTER && rasterBytes(mime, bytes)
        return Decoded(bytes, if (preview) mime else "application/octet-stream", preview)
    }
}
