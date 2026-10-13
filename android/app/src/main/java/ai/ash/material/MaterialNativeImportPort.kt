package ai.ash.material

import ai.ash.ui.transport.CoreCancellation
import ai.ash.ui.transport.CoreHttpRequest
import ai.ash.ui.transport.CoreHttpTransport
import ai.ash.ui.transport.DirectCoreHttpTransport
import org.json.JSONObject
import java.net.URL

internal data class MaterialNativeSelection(val selectionId: String, val name: String, val mediaType: String,
    val byteLength: Long, val sha256: String)
internal data class MaterialNativeImportFact(val state: String, val selection: MaterialNativeSelection?)
internal interface MaterialNativeImportPort {
    fun begin(scope: MaterialNativeScope, importId: String, source: NativeSelection, cancellation: CoreCancellation)
    fun write(scope: MaterialNativeScope, importId: String, index: Int, bytes: ByteArray, cancellation: CoreCancellation)
    fun commit(scope: MaterialNativeScope, importId: String, byteLength: Long, sha256: String, cancellation: CoreCancellation): MaterialNativeImportFact
    fun query(scope: MaterialNativeScope, importId: String, cancellation: CoreCancellation): MaterialNativeImportFact
    fun release(scope: MaterialNativeScope, importId: String)
}

/** Native-only transport. Fixed routes, real host proof and registered screen token;
 * no body-supplied bearer, endpoint, path or source bytes representation is accepted.
 */
internal class MaterialNativeHttpImportPort(corePort: Int, private val bearer: () -> String,
    private val nativeUiProof: String, private val current: (MaterialNativeScope) -> Unit,
    private val transport: CoreHttpTransport = DirectCoreHttpTransport()) : MaterialNativeImportPort {
    private val grants = mutableMapOf<String, Pair<MaterialNativeScope, String>>()
    private val root: String
    init { require(corePort in 1..65535); require(Regex("[0-9a-f]{64}").matches(nativeUiProof)); root = "http://127.0.0.1:$corePort/api/collaboration/material/native/import/" }
    override fun begin(scope: MaterialNativeScope, importId: String, source: NativeSelection, cancellation: CoreCancellation) {
        require(source.name.length in 1..256 && source.name.none { it.isISOControl() || it == '/' || it == '\\' })
        require(source.mediaType.length in 1..128 && Regex("[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+").matches(source.mediaType))
        require(source.reportedLength == null || source.reportedLength in 0..MATERIAL_FILE_BYTES)
        val value = json(scope, importId).put("name", source.name).put("media_type", source.mediaType)
            .put("reported_length", source.reportedLength ?: JSONObject.NULL)
        val reply = request(scope, "begin", value.toString().toByteArray(), cancellation)
        require(reply.getString("import_id") == importId && reply.getString("state") == "receiving" && reply.getInt("next_chunk") == 0)
        val nonce = reply.getString("upload_nonce"); require(Regex("[A-Za-z0-9_-]{16,128}|[0-9a-f-]{36}").matches(nonce))
        synchronized(this) { require(grants.size < 64); grants[importId] = scope to nonce }
    }
    override fun write(scope: MaterialNativeScope, importId: String, index: Int, bytes: ByteArray, cancellation: CoreCancellation) {
        require(index >= 0 && bytes.size in 1..MATERIAL_CHUNK_BYTES)
        request(scope, "write", bytes, cancellation, mapOf("x-ash-material-import" to materialId(importId), "x-ash-material-chunk" to index.toString(), "x-ash-material-page" to scope.pageEpoch.toString(), "x-ash-material-nonce" to nonce(scope, importId)))
    }
    override fun commit(scope: MaterialNativeScope, importId: String, byteLength: Long, sha256: String, cancellation: CoreCancellation): MaterialNativeImportFact {
        require(byteLength in 0..MATERIAL_FILE_BYTES && Regex("[0-9a-f]{64}").matches(sha256))
        return fact(request(scope, "commit", json(scope, importId).put("upload_nonce", nonce(scope, importId)).put("byte_length", byteLength).put("sha256", sha256).toString().toByteArray(), cancellation))
    }
    override fun query(scope: MaterialNativeScope, importId: String, cancellation: CoreCancellation) =
        fact(request(scope, "query", json(scope, importId).toString().toByteArray(), cancellation))
    override fun release(scope: MaterialNativeScope, importId: String) {
        // Cleanup of an original native session remains permitted after local navigation.
        // Core still checks the captured owner/screen; release never deletes A1 snapshots.
        try { request(scope, "release", json(scope, importId).toString().toByteArray(), CoreCancellation(), cleanup = true) }
        finally { synchronized(this) { grants.remove(importId) } }
    }
    private fun nonce(scope: MaterialNativeScope, importId: String): String = synchronized(this) {
        grants[importId]?.takeIf { it.first == scope }?.second ?: error("native upload grant unavailable")
    }
    private fun json(scope: MaterialNativeScope, importId: String): JSONObject {
        require(scope.pageEpoch > 0); return JSONObject().put("import_id", materialId(importId)).put("page_epoch", scope.pageEpoch)
    }
    private fun request(scope: MaterialNativeScope, operation: String, bytes: ByteArray, cancellation: CoreCancellation,
        extra: Map<String, String> = emptyMap(), cleanup: Boolean = false): JSONObject {
        require(operation in setOf("begin", "write", "commit", "query", "release"))
        require(bytes.size <= 64 * 1024)
        if (!cleanup) current(scope)
        check(!cancellation.cancelled)
        val token = bearer()
        require(token.isNotBlank() && token.length <= 4096 && token.none { it == '\r' || it == '\n' })
        require(Regex("[A-Za-z0-9_-]{32,128}").matches(scope.screenToken))
        val headers = mapOf("authorization" to "Bearer $token", "x-ash-native-ui" to nativeUiProof,
            "ash-screen" to scope.screenToken, "content-type" to if (operation == "write") "application/octet-stream" else "application/json") + extra
        val response = transport.execute(CoreHttpRequest(URL(root + operation), "POST", headers, bytes, false), cancellation) {}
        if (!cleanup) current(scope)
        check(!cancellation.cancelled)
        require(response.body.size <= 64 * 1024 && response.status == 200)
        val encoded = response.body.toString(Charsets.UTF_8)
        require(!encoded.contains(token) && !encoded.contains(nativeUiProof))
        val body = JSONObject(encoded)
        require(body.optBoolean("ok", false))
        return body.getJSONObject("result")
    }
    private fun fact(body: JSONObject): MaterialNativeImportFact {
        val state = body.getString("state"); require(state in setOf("committed", "receiving", "unknown"))
        val selected = body.optJSONObject("selection")
        if (state != "committed") return MaterialNativeImportFact(state, null)
        require(selected != null && selected.keys().asSequence().toSet() == setOf("selection_id", "name", "media_type", "byte_length", "sha256"))
        val length = selected!!.getLong("byte_length"); val hash = selected.getString("sha256")
        require(length in 0..MATERIAL_FILE_BYTES && Regex("[0-9a-f]{64}").matches(hash))
        val selection = MaterialNativeSelection(materialId(selected.getString("selection_id")), materialId(selected.getString("name")),
            materialId(selected.getString("media_type")), length, hash)
        return MaterialNativeImportFact(state, selection)
    }
}
