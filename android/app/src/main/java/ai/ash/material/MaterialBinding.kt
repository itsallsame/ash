package ai.ash.material

import java.io.InputStream

/** Created only by the native authenticated host, never from page/model fields. */
internal data class MaterialBinding(
    val pageEpoch: Long, val screenId: String, val principalId: String,
    val requestId: String, val custodyId: String, val generation: String,
)
internal interface MaterialAuthority {
    fun binding(): MaterialBinding
    /** Must check live page, owner, pairing/grant generation and exact request custody. */
    fun current(binding: MaterialBinding)
}
internal data class SelectionMetadata(val selectionId: String, val name: String, val mediaType: String, val byteLength: Long?)
internal enum class ImportState { COMMITTED, UNKNOWN }
internal data class ImportFact(val state: ImportState, val byteLength: Long?, val sha256: String?, val phonePrivateStore: Boolean)
internal data class ControlledMaterial(val input: InputStream, val byteLength: Long, val sha256: String)
internal enum class ConsumeFact { CONSUMED, UNKNOWN }

/** Fixed operations only. The implementing native transport authenticates the host and
 * reauthorizes binding against Core's private custody registry on every operation.
 * Stable IDs survive lost responses: query does not create a transfer or business task.
 * COMMITTED requires A1 durable destination proof, not HTTP success or a source snapshot.
 */
internal interface MaterialCorePort {
    fun beginImport(binding: MaterialBinding, importId: String, metadata: SelectionMetadata)
    fun writeChunk(binding: MaterialBinding, importId: String, index: Int, bytes: ByteArray)
    fun commitImport(binding: MaterialBinding, importId: String, byteLength: Long, sha256: String): ImportFact
    fun queryImport(binding: MaterialBinding, importId: String): ImportFact
    fun read(binding: MaterialBinding, assetId: String, assetVersion: Int, resultVersion: Int): ControlledMaterial
    fun consume(binding: MaterialBinding, resultVersion: Int, consumeId: String): ConsumeFact
    fun queryConsume(binding: MaterialBinding, resultVersion: Int, consumeId: String): ConsumeFact
}
internal const val MATERIAL_CHUNK_BYTES = 40 * 1024
internal const val MATERIAL_FILE_BYTES = 4L * 1024 * 1024
internal const val MATERIAL_REQUEST_BYTES = 8L * 1024 * 1024
internal fun materialId(value: String): String {
    require(value.isNotBlank() && value.length <= 256 && value.none { it.isISOControl() }) { "invalid material id" }
    return value
}
internal fun materialHash(bytes: ByteArray): String = java.security.MessageDigest.getInstance("SHA-256")
    .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }

/** Content-provider streams may return short reads; fill fixed Core chunk boundaries. */
internal fun readMaterialChunk(input: InputStream, buffer: ByteArray, current: () -> Unit): Int {
    var used = 0
    while (used < buffer.size) {
        current()
        val count = input.read(buffer, used, buffer.size - used)
        current()
        if (count < 0) break
        if (count > 0) used += count
    }
    return if (used == 0) -1 else used
}
