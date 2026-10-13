package ai.ash.material

import ai.ash.ui.transport.CoreCancellation
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.security.MessageDigest
import java.util.UUID

internal interface MaterialNativeBatchPicker {
    fun select(maxFiles: Int, failed: (String) -> Unit, done: (List<NativeSelection>?) -> Unit)
    fun cancel()
}

/** Draft selection has no canonical request yet. Native import prepares a trusted
 * source FD; the Core coordinator later binds capture to exact request/custody and
 * registers A1. A prepared selection is never a destination arrival receipt.
 */
internal class MaterialNativeSelectionBridge(private val scope: () -> MaterialNativeScope,
    private val current: (MaterialNativeScope) -> Unit, private val picker: MaterialNativeBatchPicker,
    private val port: MaterialNativeImportPort, private val execute: ((() -> Unit) -> Unit),
    private val post: ((() -> Unit) -> Unit)) : Closeable {
    private data class Import(val id: String, var length: Long? = null, var hash: String? = null)
    private class Job(val binding: MaterialNativeScope, val maxFiles: Int, val imports: MutableList<Import> = mutableListOf(),
        val cancellation: CoreCancellation = CoreCancellation(), var state: String = "picking",
        var selections: List<MaterialNativeSelection> = emptyList(), var error: String? = null) {
        val streams = mutableSetOf<Closeable>()
    }
    private val jobs = linkedMapOf<String, Job>()
    @Volatile private var closed = false
    private fun checkCurrent(job: Job) { check(!closed && !job.cancellation.cancelled); current(job.binding) }
    fun receive(origin: String, mainFrame: Boolean, pageEpoch: Long, raw: String, reply: (String) -> Unit) {
        if (closed || origin != "https://appassets.androidplatform.net" || !mainFrame || pageEpoch <= 0 || raw.length > 1024) return
        val binding = runCatching { scope().also { require(it.pageEpoch == pageEpoch); current(it) } }.getOrNull() ?: return
        val input = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val type = input.optString("type"); val id = runCatching { materialId(input.getString("id")) }.getOrNull() ?: return
        if (type !in setOf("material_select", "material_cancel", "material_picker_close")) return
        val keys = input.keys().asSequence().toSet()
        val maxFiles = when {
            keys == setOf("type", "id") -> 4
            type == "material_select" && keys == setOf("type", "id", "max_files", "max_file_bytes") &&
                input.opt("max_files") == 1 && input.opt("max_file_bytes") == 4194304 -> 1
            else -> return
        }
        fun send(body: JSONObject) { runCatching { post {
            if (!closed && runCatching { current(binding) }.isSuccess)
                runCatching { reply(body.put("id", id).put("type", "${type}_result").toString()) }
        } } }
        fun failure(code: String) = JSONObject().put("ok", false).put("error", JSONObject().put("code", code).put("message", "Material $code"))
        if (type == "material_picker_close") { close(); return }
        if (type == "material_cancel") {
            val job = synchronized(this) { jobs[id]?.takeIf { it.binding == binding } }
            if (job != null) { stop(job); picker.cancel(); release(job) }
            send(JSONObject().put("ok", true).put("cancelled", true)); return
        }
        val (job, retry) = synchronized(this) {
            if (closed) return
            jobs[id]?.let { existing ->
                if (existing.binding != binding || existing.maxFiles != maxFiles) return
                existing to true
            } ?: run {
                if (jobs.size >= 64) { send(failure("too_large")); return }
                val fresh = Job(binding, maxFiles); jobs[id] = fresh; fresh to false
            }
        }
        fun result(selections: List<MaterialNativeSelection>, cancelled: Boolean = false): JSONObject {
            val values = JSONArray()
            selections.forEach { values.put(JSONObject().put("selection_id", it.selectionId).put("name", it.name)
                .put("media_type", it.mediaType).put("byte_length", it.byteLength).put("sha256", it.sha256)) }
            return JSONObject().put("ok", true).put("cancelled", cancelled).put("selections", values)
        }
        fun enqueue(work: () -> List<MaterialNativeSelection>) {
            try { execute {
                val body = try {
                    checkCurrent(job)
                    val selections = work(); checkCurrent(job)
                    synchronized(this) { job.state = "committed"; job.selections = selections }
                    result(selections)
                } catch (_: Exception) {
                    synchronized(this) { if (!job.cancellation.cancelled) job.state = "unknown" }
                    failure("result_unknown")
                } finally { closeStreams(job) }
                send(body)
            } } catch (_: Exception) {
                synchronized(this) { job.state = "unknown" }
                closeStreams(job); send(failure("offline"))
            }
        }
        if (retry) {
            val state = synchronized(this) { job.state }
            when (state) {
                "committed" -> send(result(job.selections))
                "cancelled" -> send(result(emptyList(), true))
                "rejected" -> send(failure(job.error ?: "offline"))
                "unknown" -> enqueue { query(job) }
                else -> send(failure("conflict"))
            }
            return
        }
        try { picker.select(job.maxFiles, failed = { code ->
            val safeCode = code.takeIf { it in setOf("invalid", "too_large", "unsupported", "permission_denied", "offline") } ?: "offline"
            synchronized(this) { job.state = "rejected"; job.error = safeCode }
            send(failure(safeCode))
        }) { sources ->
            if (sources == null) {
                synchronized(this) { job.state = "cancelled" }
                send(result(emptyList(), true)); return@select
            }
            try {
                synchronized(this) {
                    checkCurrent(job); require(sources.size in 1..job.maxFiles)
                    if (job.maxFiles == 1) require(sources.all {
                        it.mediaType in setOf("image/png", "image/jpeg") &&
                            (it.reportedLength == null || it.reportedLength in 0..MATERIAL_FILE_BYTES)
                    })
                    sources.forEach { job.streams.add(it.input) }
                    job.state = "importing"
                    sources.forEach { job.imports.add(Import(UUID.randomUUID().toString())) }
                }
            } catch (_: Exception) {
                sources.forEach { runCatching { it.input.close() } }; send(failure("permission_denied")); return@select
            }
            enqueue { import(job, sources) }
        } } catch (_: Exception) { stop(job); send(failure("offline")) }
    }
    private fun import(job: Job, sources: List<NativeSelection>): List<MaterialNativeSelection> {
        var total = 0L
        return sources.mapIndexed { index, source ->
            val operation = job.imports[index]
            checkCurrent(job)
            port.begin(job.binding, operation.id, source, job.cancellation); checkCurrent(job)
            val digest = MessageDigest.getInstance("SHA-256")
            var length = 0L; var chunk = 0
            val bytes = ByteArray(MATERIAL_CHUNK_BYTES)
            source.input.use { stream ->
                while (true) {
                    checkCurrent(job); val count = readMaterialChunk(stream, bytes) { checkCurrent(job) }
                    if (count < 0) break; if (count == 0) continue
                    length += count; total += count
                    require(length <= MATERIAL_FILE_BYTES && total <= MATERIAL_REQUEST_BYTES)
                    digest.update(bytes, 0, count)
                    checkCurrent(job); port.write(job.binding, operation.id, chunk++, bytes.copyOf(count), job.cancellation); checkCurrent(job)
                }
            }
            require(source.reportedLength == null || source.reportedLength == length)
            val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
            synchronized(this) { operation.length = length; operation.hash = hash }
            checkCurrent(job)
            val committed = try { port.commit(job.binding, operation.id, length, hash, job.cancellation) }
                catch (_: Exception) { checkCurrent(job); port.query(job.binding, operation.id, job.cancellation) }
            verified(job, operation, committed)
        }
    }
    private fun query(job: Job): List<MaterialNativeSelection> {
        checkCurrent(job); require(job.imports.isNotEmpty())
        return job.imports.map { operation ->
            verified(job, operation, port.query(job.binding, operation.id, job.cancellation))
        }
    }
    private fun verified(job: Job, operation: Import, fact: MaterialNativeImportFact): MaterialNativeSelection {
        checkCurrent(job)
        require(fact.state == "committed" && fact.selection != null)
        val selection = fact.selection!!
        require(operation.length != null && selection.byteLength == operation.length && selection.sha256 == operation.hash)
        return selection
    }
    @Synchronized private fun closeStreams(job: Job) {
        job.streams.forEach { runCatching { it.close() } }; job.streams.clear()
    }
    @Synchronized private fun stop(job: Job) {
        job.state = "cancelled"; job.cancellation.cancel(); closeStreams(job)
    }
    private fun release(job: Job) {
        runCatching { execute { job.imports.forEach { runCatching { port.release(job.binding, it.id) } } } }
    }
    @Synchronized override fun close() {
        if (closed) return
        closed = true; runCatching { picker.cancel() }
        jobs.values.forEach { stop(it); release(it) }; jobs.clear()
    }
}
