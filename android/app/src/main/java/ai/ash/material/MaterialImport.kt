package ai.ash.material

import java.io.Closeable
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.Timer
import java.util.TimerTask

/** Active native streams are separate from bounded stable-operation metadata. */
internal class MaterialImport(private val authority: MaterialAuthority, private val core: MaterialCorePort,
    private val now: () -> Long = System::nanoTime) : Closeable {
    private data class Record(val binding: MaterialBinding, val metadata: SelectionMetadata,
        var started: Boolean = false, var length: Long? = null, var hash: String? = null)
    private data class Selection(val record: Record, val input: InputStream, val expiresAt: Long, val expiry: TimerTask)
    private val active = mutableMapOf<String, Selection>()
    private val records = linkedMapOf<String, Record>()
    private val totals = mutableMapOf<MaterialBinding, Long>()
    private val timer = Timer("ash-material-selection-expiry", true)
    @Volatile private var closed = false
    private fun current(binding: MaterialBinding) { check(!closed); authority.current(binding) }
    @Synchronized fun expireHandles() {
        val expired = active.filterValues { now() >= it.expiresAt }.keys.toList()
        expired.forEach { release(it) }
    }
    private fun release(id: String) {
        active.remove(id)?.let { selection ->
            selection.expiry.cancel(); timer.purge(); runCatching { selection.input.close() }
            if (!selection.record.started) records.remove(id)
        }
    }
    @Synchronized fun select(binding: MaterialBinding, name: String, mediaType: String, reportedLength: Long?, input: InputStream): SelectionMetadata {
        try {
            current(binding); expireHandles()
            require(name.isNotBlank() && name.length <= 256 && name.none { it.isISOControl() || it == '/' || it == '\\' })
            require(mediaType.length <= 128 && Regex("[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+").matches(mediaType))
            require(reportedLength == null || reportedLength in 0..MATERIAL_FILE_BYTES)
            require(active.size < 4)
            require(records.size < 64) { "operation capacity" }
            // Unknown operations retain their stable IDs until this page is closed;
            // capacity never evicts a potentially committed operation.
            val metadata = SelectionMetadata(UUID.randomUUID().toString(), name, mediaType, reportedLength)
            val record = Record(binding, metadata)
            val expiry = object : TimerTask() { override fun run() { synchronized(this@MaterialImport) { if (!closed) expireHandles() } } }
            active[metadata.selectionId] = Selection(record, input, now() + 300_000_000_000L, expiry)
            records[metadata.selectionId] = record
            timer.schedule(expiry, 300_000)
            return metadata
        } catch (e: Exception) { runCatching { input.close() }; throw e }
    }
    private fun record(binding: MaterialBinding, id: String): Record = synchronized(this) {
        current(binding); expireHandles()
        records[materialId(id)]?.takeIf { it.binding == binding } ?: error("selection unavailable")
    }
    fun import(binding: MaterialBinding, id: String): ImportFact {
        val record = record(binding, id)
        val selection = synchronized(this) {
            if (record.started) null else {
                val selected = active[id] ?: error("selection unavailable")
                record.started = true; selected
            }
        } ?: return query(binding, id)
        try {
            fun currentSelection() { current(binding); synchronized(this) { check(active[id] === selection && now() < selection.expiresAt) } }
            currentSelection(); core.beginImport(binding, id, record.metadata); currentSelection()
            val digest = MessageDigest.getInstance("SHA-256")
            var length = 0L; var index = 0
            val buffer = ByteArray(MATERIAL_CHUNK_BYTES)
            selection.input.use { input ->
                while (true) {
                    currentSelection()
                    val count = readMaterialChunk(input, buffer, ::currentSelection); if (count < 0) break; if (count == 0) continue
                    length += count; require(length <= MATERIAL_FILE_BYTES) { "file too large" }
                    synchronized(this) {
                        val total = (totals[binding] ?: 0) + count
                        require(total <= MATERIAL_REQUEST_BYTES) { "request too large" }; totals[binding] = total
                    }
                    digest.update(buffer, 0, count)
                    currentSelection(); core.writeChunk(binding, id, index++, buffer.copyOf(count)); currentSelection()
                }
            }
            val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
            require(record.metadata.byteLength == null || record.metadata.byteLength == length) { "picker length mismatch" }
            synchronized(this) { record.length = length; record.hash = hash }
            currentSelection()
            val fact = try { core.commitImport(binding, id, length, hash) } catch (_: Exception) { current(binding); core.queryImport(binding, id) }
            return verified(binding, record, fact)
        } finally { synchronized(this) { release(id) }; runCatching { selection.input.close() } }
    }
    fun query(binding: MaterialBinding, id: String): ImportFact {
        val record = record(binding, id)
        return verified(binding, record, core.queryImport(binding, id))
    }
    private fun verified(binding: MaterialBinding, record: Record, fact: ImportFact): ImportFact {
        current(binding)
        synchronized(this) { if (fact.state == ImportState.COMMITTED)
            require(record.length != null && record.hash != null && fact.byteLength == record.length && fact.sha256 == record.hash) }
        return fact
    }
    @Synchronized override fun close() {
        closed = true; timer.cancel(); active.keys.toList().forEach { release(it) }; records.clear(); totals.clear()
    }
}
