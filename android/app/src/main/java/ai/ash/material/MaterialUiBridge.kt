package ai.ash.material

import android.content.Intent
import android.content.ContentResolver
import android.net.Uri
import java.io.Closeable
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import org.json.JSONObject

internal data class NativeSelection(val name: String, val mediaType: String, val reportedLength: Long?, val input: InputStream)
internal interface MaterialNativePicker {
    /** Launch system OPEN_DOCUMENT; cancellation returns null. URI remains native. */
    fun select(done: (NativeSelection?) -> Unit)
    /** Launch system CREATE_DOCUMENT only following explicit material_export. */
    fun export(name: String, mediaType: String, done: (OutputStream?) -> Unit)
}
internal fun materialSelectIntent(): Intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
    addCategory(Intent.CATEGORY_OPENABLE); type = "*/*"
}
/** Precheck the system result before querying or opening any returned URI. */
internal fun materialPickerResultError(maxFiles: Int, count: Int, contentOnly: Boolean): String? =
    if (count !in 1..maxFiles || !contentOnly) "invalid" else null
internal fun materialImageSelectionError(mediaType: String, length: Long?): String? = when {
    mediaType !in setOf("image/png", "image/jpeg") -> "unsupported"
    length != null && length < 0 -> "invalid"
    length != null && length > MATERIAL_FILE_BYTES -> "too_large"
    else -> null
}
internal fun materialNativeSelectIntent(maxFiles: Int): Intent {
    require(maxFiles == 1 || maxFiles == 4)
    return materialSelectIntent().apply {
        type = if (maxFiles == 1) "image/*" else "*/*"
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, maxFiles == 4)
        putExtra(Intent.EXTRA_MIME_TYPES, if (maxFiles == 1) arrayOf("image/png", "image/jpeg")
            else arrayOf("text/plain", "image/png", "image/jpeg"))
    }
}
internal fun materialExportIntent(name: String, mediaType: String): Intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
    addCategory(Intent.CATEGORY_OPENABLE); type = mediaType; putExtra(Intent.EXTRA_TITLE, name)
}
/** Only a URI returned to the native picker result callback may reach these helpers. */
internal fun openMaterialSelection(resolver: ContentResolver, uri: Uri, name: String, mediaType: String, length: Long?): NativeSelection =
    NativeSelection(name, mediaType, length, resolver.openInputStream(uri) ?: error("selection unavailable"))
internal fun openMaterialExport(resolver: ContentResolver, uri: Uri): OutputStream =
    resolver.openOutputStream(uri, "wt") ?: error("export unavailable")

/** Host installs this behind WebViewCompat.addWebMessageListener with exact origin.
 * No JavaScriptInterface, arbitrary URL/path or model-provided binding is accepted.
 * Native authority must invalidate before navigation/scope replacement; close this bridge
 * on navigation/destroy. Work runs through the injected executor, replies through UI dispatch.
 */
internal class MaterialUiBridge(
    private val authority: MaterialAuthority, private val core: MaterialCorePort,
    private val picker: MaterialNativePicker,
    private val execute: ((() -> Unit) -> Unit), private val post: ((() -> Unit) -> Unit),
    private val encode: (ByteArray) -> String = { android.util.Base64.encodeToString(it, android.util.Base64.NO_WRAP) },
    private val now: () -> Long = System::nanoTime,
) : Closeable {
    private val imports = MaterialImport(authority, core, now)
    private data class ReadHandle(val binding: MaterialBinding, val resultVersion: Int, val consumeId: String, val expiresAt: Long, var used: Boolean = false)
    private val reads = mutableMapOf<String, ReadHandle>()
    private val consumeRecords = linkedMapOf<String, ReadHandle>()
    private val activeStreams = mutableSetOf<Closeable>()
    @Volatile private var closed = false

    fun receive(origin: String, mainFrame: Boolean, pageEpoch: Long, raw: String, reply: (String) -> Unit) {
        if (closed || origin != "https://appassets.androidplatform.net" || !mainFrame || pageEpoch <= 0 || raw.length > 4096) return
        val binding = runCatching { authority.binding().also { require(it.pageEpoch == pageEpoch); authority.current(it) } }.getOrNull() ?: return
        val input = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val type = input.optString("type")
        val keys = when (type) {
            "material_select" -> setOf("type", "id")
            "material_import" -> setOf("type", "id", "selection_id")
            "material_read" -> setOf("type", "id", "request_id", "asset_id", "asset_version", "result_version")
            "material_consume" -> setOf("type", "id", "request_id", "consume_handle", "result_version")
            "material_export" -> setOf("type", "id", "request_id", "asset_id", "asset_version", "result_version", "name", "media_type")
            else -> return
        }
        if (input.keys().asSequence().toSet() != keys) return
        val id = runCatching { text(input, "id") }.getOrNull() ?: return
        if ("request_id" in keys && runCatching { text(input, "request_id") == binding.requestId }.getOrDefault(false).not()) return
        fun send(body: JSONObject) { runCatching { post {
            if (!closed && runCatching { authority.current(binding) }.isSuccess)
                reply(body.put("type", "${type}_result").put("id", id).toString())
        } } }
        fun work(resource: Closeable? = null, retained: () -> Boolean = { false }, action: () -> JSONObject) {
            fun cleanup() {
                synchronized(this) { if (resource != null) activeStreams.remove(resource) }
                if (resource != null && !retained()) runCatching { resource.close() }
            }
            try {
                synchronized(this) { checkCurrent(binding); if (resource != null) activeStreams.add(resource) }
                execute {
                    val result = try {
                        runCatching { checkCurrent(binding); action().also { checkCurrent(binding) } }
                            .getOrElse { JSONObject().put("ok", false).put("error", "material_unavailable") }
                    } finally { cleanup() }
                    send(result)
                }
            } catch (_: Exception) {
                cleanup()
                send(JSONObject().put("ok", false).put("error", "material_unavailable"))
            }
        }
        try {
            when (type) {
                "material_select" -> picker.select { selection ->
                    if (selection == null) send(JSONObject().put("ok", true).put("cancelled", true))
                    else if (runCatching { checkCurrent(binding) }.isFailure) { runCatching { selection.input.close() } }
                    else { var retained = false; work(resource = selection.input, retained = { retained }) {
                        val metadata = try { imports.select(binding, selection.name, selection.mediaType, selection.reportedLength, selection.input) }
                            catch (e: Exception) { runCatching { selection.input.close() }; throw e }
                        retained = true
                        JSONObject().put("ok", true).put("selection_id", metadata.selectionId).put("name", metadata.name)
                            .put("media_type", metadata.mediaType).put("byte_length", metadata.byteLength ?: JSONObject.NULL)
                    } }
                }
                "material_import" -> { val selectionId = text(input, "selection_id"); work {
                    val fact = imports.import(binding, selectionId)
                    JSONObject().put("ok", true).put("state", fact.state.name.lowercase())
                        .put("phone_arrived", fact.state == ImportState.COMMITTED && fact.phonePrivateStore)
                        .put("byte_length", fact.byteLength ?: JSONObject.NULL).put("sha256", fact.sha256 ?: JSONObject.NULL)
                } }
                "material_read" -> {
                    val assetId = text(input, "asset_id"); val assetVersion = version(input, "asset_version"); val resultVersion = version(input, "result_version")
                    work {
                        val bytes = read(binding, assetId, assetVersion, resultVersion)
                        val handle = UUID.randomUUID().toString()
                        synchronized(this) {
                            checkCurrent(binding); expireReads(); require(reads.size < 8)
                            reads[handle] = ReadHandle(binding, resultVersion, UUID.randomUUID().toString(), now() + 300_000_000_000L)
                        }
                        JSONObject().put("ok", true).put("bytes_base64", encode(bytes))
                            .put("verified_sha256", materialHash(bytes)).put("consume_handle", handle)
                            .put("request_id", binding.requestId).put("result_version", resultVersion).put("asset_id", assetId).put("asset_version", assetVersion)
                    }
                }
                "material_consume" -> {
                    val handle = text(input, "consume_handle"); val resultVersion = version(input, "result_version")
                    work {
                        val (read, retry) = synchronized(this) {
                            checkCurrent(binding); expireReads()
                            val prior = consumeRecords[handle]
                            if (prior != null) {
                                require(prior.binding == binding && prior.resultVersion == resultVersion)
                                prior to true
                            } else {
                                val fresh = reads[handle]?.takeIf { it.binding == binding && it.resultVersion == resultVersion }
                                    ?: error("read handle unavailable")
                                // Reserve once ID before side effects. Full history rejects new
                                // consumes and preserves UNKNOWN operations for stable-ID queries.
                                require(consumeRecords.size < 64) { "operation capacity" }
                                reads.remove(handle); fresh.used = true; consumeRecords[handle] = fresh
                                fresh to false
                            }
                        }
                        val fact = if (retry) core.queryConsume(binding, resultVersion, read.consumeId)
                            else try { core.consume(binding, resultVersion, read.consumeId) }
                            catch (_: Exception) { checkCurrent(binding); core.queryConsume(binding, resultVersion, read.consumeId) }
                        JSONObject().put("ok", true).put("state", fact.name.lowercase())
                    }
                }
                "material_export" -> {
                    val assetId = text(input, "asset_id"); val assetVersion = version(input, "asset_version"); val resultVersion = version(input, "result_version")
                    val name = text(input, "name"); require(name.none { it == '/' || it == '\\' })
                    val mediaType = text(input, "media_type"); require(Regex("[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+").matches(mediaType))
                    picker.export(name, mediaType) { output ->
                        if (output == null) send(JSONObject().put("ok", true).put("cancelled", true))
                        else if (runCatching { checkCurrent(binding) }.isFailure) { runCatching { output.close() } }
                        else work(resource = output) {
                            try {
                                synchronized(this) { checkCurrent(binding); activeStreams.add(output) }
                                val bytes = read(binding, assetId, assetVersion, resultVersion)
                                output.use { target ->
                                    var offset = 0
                                    while (offset < bytes.size) { checkCurrent(binding); val count = minOf(MATERIAL_CHUNK_BYTES, bytes.size - offset); target.write(bytes, offset, count); offset += count }
                                    target.flush()
                                }
                                JSONObject().put("ok", true).put("exported", true).put("verified_sha256", materialHash(bytes))
                            } finally { synchronized(this) { activeStreams.remove(output) }; runCatching { output.close() } }
                        }
                    }
                }
            }
        } catch (_: Exception) { send(JSONObject().put("ok", false).put("error", "material_unavailable")) }
    }
    private fun read(binding: MaterialBinding, assetId: String, assetVersion: Int, resultVersion: Int): ByteArray {
        checkCurrent(binding)
        val controlled = core.read(binding, assetId, assetVersion, resultVersion)
        try {
            synchronized(this) { checkCurrent(binding); activeStreams.add(controlled.input) }
            require(controlled.byteLength in 0..MATERIAL_FILE_BYTES && Regex("[0-9a-f]{64}").matches(controlled.sha256))
            val bytes = java.io.ByteArrayOutputStream()
            controlled.input.use { source ->
                val buffer = ByteArray(MATERIAL_CHUNK_BYTES)
                while (true) {
                    checkCurrent(binding); val count = source.read(buffer); if (count < 0) break
                    require(bytes.size().toLong() + count <= controlled.byteLength); bytes.write(buffer, 0, count)
                }
            }
            val result = bytes.toByteArray()
            require(result.size.toLong() == controlled.byteLength && materialHash(result) == controlled.sha256)
            checkCurrent(binding); return result
        } finally { synchronized(this) { activeStreams.remove(controlled.input) }; runCatching { controlled.input.close() } }
    }
    @Synchronized private fun expireReads() {
        reads.entries.removeAll { now() >= it.value.expiresAt }
    }
    private fun checkCurrent(binding: MaterialBinding) { check(!closed); authority.current(binding) }
    @Synchronized override fun close() {
        closed = true; imports.close(); reads.clear(); consumeRecords.clear()
        activeStreams.forEach { runCatching { it.close() } }; activeStreams.clear()
    }
    private fun text(input: JSONObject, key: String): String = materialId(input.get(key).also { require(it is String) } as String)
    private fun version(input: JSONObject, key: String): Int {
        val value = input.get(key); require(value is Int && value > 0); return value
    }
}
