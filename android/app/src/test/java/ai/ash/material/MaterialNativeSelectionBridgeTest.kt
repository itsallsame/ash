package ai.ash.material

import ai.ash.ui.transport.CoreCancellation
import ai.ash.ui.transport.CoreHttpReply
import ai.ash.ui.transport.CoreHttpRequest
import ai.ash.ui.transport.CoreHttpTransport
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class MaterialNativeSelectionBridgeTest {
    private val nativeScope = MaterialNativeScope(1, "screen:test", "a".repeat(32), "v1_" + "b".repeat(43), "generation")
    private class Picker : MaterialNativeBatchPicker {
        var selection: List<NativeSelection>? = null
        var calls = 0
        var maxFiles = 0
        var error: String? = null
        override fun select(maxFiles: Int, failed: (String) -> Unit, done: (List<NativeSelection>?) -> Unit) { calls++; this.maxFiles = maxFiles; error?.let { failed(it) } ?: done(selection) }
        override fun cancel() {}
    }
    private class Port : MaterialNativeImportPort {
        val rows = mutableMapOf<String, ByteArrayOutputStream>()
        val types = mutableMapOf<String, String>()
        val chunks = mutableMapOf<String, MutableList<Int>>()
        var afterWrite: (() -> Unit)? = null
        var begins = 0; var commits = 0; var queries = 0; var lostAck = false; var unknown = false
        val queriedIds = mutableListOf<String>()
        override fun begin(scope: MaterialNativeScope, importId: String, source: NativeSelection, cancellation: CoreCancellation) {
            begins++; rows[importId] = ByteArrayOutputStream(); types[importId] = source.mediaType; chunks[importId] = mutableListOf()
        }
        override fun write(scope: MaterialNativeScope, importId: String, index: Int, bytes: ByteArray, cancellation: CoreCancellation) {
            val prior = chunks.getValue(importId); require(index == prior.size)
            if (prior.isNotEmpty()) require(prior.last() == MATERIAL_CHUNK_BYTES)
            require(bytes.size in 1..MATERIAL_CHUNK_BYTES); prior.add(bytes.size); rows.getValue(importId).write(bytes); afterWrite?.invoke()
        }
        private fun fact(id: String): MaterialNativeImportFact {
            val bytes = rows[id]?.toByteArray() ?: return MaterialNativeImportFact("unknown", null)
            return if (unknown) MaterialNativeImportFact("unknown", null) else MaterialNativeImportFact("committed",
                MaterialNativeSelection("selection:$id", "file", types.getValue(id), bytes.size.toLong(), materialHash(bytes)))
        }
        override fun commit(scope: MaterialNativeScope, importId: String, byteLength: Long, sha256: String, cancellation: CoreCancellation): MaterialNativeImportFact {
            commits++; val bytes = rows.getValue(importId).toByteArray()
            require(bytes.size.toLong() == byteLength && materialHash(bytes) == sha256)
            if (lostAck) error("ack lost"); return fact(importId)
        }
        override fun query(scope: MaterialNativeScope, importId: String, cancellation: CoreCancellation): MaterialNativeImportFact {
            queries++; queriedIds.add(importId); return fact(importId)
        }
        override fun release(scope: MaterialNativeScope, importId: String) {}
    }
    private fun call(bridge: MaterialNativeSelectionBridge, replies: MutableList<String>, id: String = "1") {
        bridge.receive("https://appassets.androidplatform.net", true, 1, "{\"type\":\"material_select\",\"id\":\"$id\"}", replies::add)
    }
    @Test fun realStreamShortReadsFillFixedChunksAndOnlyMetadataReachesPage() {
        val bytes = ByteArray(MATERIAL_CHUNK_BYTES + 3) { 65 }
        val short = object : ByteArrayInputStream(bytes) {
            override fun read(buffer: ByteArray, offset: Int, length: Int) = super.read(buffer, offset, minOf(length, 7))
        }
        val picker = Picker().also { it.selection = listOf(NativeSelection("file", "text/plain", null, short)) }
        val port = Port(); val replies = mutableListOf<String>()
        val bridge = MaterialNativeSelectionBridge({ nativeScope }, { check(it == nativeScope) }, picker, port, { it() }, { it() })
        call(bridge, replies)
        val body = JSONObject(replies.single()); val selection = body.getJSONArray("selections").getJSONObject(0)
        assertEquals(bytes.size.toLong(), selection.getLong("byte_length")); assertEquals(materialHash(bytes), selection.getString("sha256"))
        assertEquals(setOf("selection_id", "name", "media_type", "byte_length", "sha256"), selection.keys().asSequence().toSet())
        assertEquals(listOf(MATERIAL_CHUNK_BYTES, 3), port.chunks.values.single()); assertEquals(1, port.commits)
        assertFalse(replies.single().contains("content://")); assertFalse(replies.single().contains("bytes_base64")); bridge.close()
    }
    @Test fun lostCommitAckQueriesOriginalIdAndRepeatedSelectionDoesNotReupload() {
        val picker = Picker().also { it.selection = listOf(NativeSelection("file", "text/plain", 0, ByteArrayInputStream(byteArrayOf()))) }
        val port = Port().also { it.lostAck = true }; val replies = mutableListOf<String>()
        val bridge = MaterialNativeSelectionBridge({ nativeScope }, {}, picker, port, { it() }, { it() })
        call(bridge, replies); call(bridge, replies)
        assertTrue(JSONObject(replies.last()).getBoolean("ok")); assertEquals(0, JSONObject(replies.last()).getJSONArray("selections").getJSONObject(0).getLong("byte_length").toInt())
        assertEquals(1, picker.calls); assertEquals(1, port.begins); assertEquals(1, port.commits); assertEquals(1, port.queries); bridge.close()
    }
    @Test fun cancellationWrongOriginAndPageInputCannotStartNativeImport() {
        val picker = Picker(); val port = Port(); val replies = mutableListOf<String>()
        val bridge = MaterialNativeSelectionBridge({ nativeScope }, {}, picker, port, { it() }, { it() })
        bridge.receive("https://evil.example", true, 1, "{\"type\":\"material_select\",\"id\":\"1\"}", replies::add)
        bridge.receive("https://appassets.androidplatform.net", false, 1, "{\"type\":\"material_select\",\"id\":\"1\"}", replies::add)
        bridge.receive("https://appassets.androidplatform.net", true, 2, "{\"type\":\"material_select\",\"id\":\"1\"}", replies::add)
        bridge.receive("https://appassets.androidplatform.net", true, 1, "{\"type\":\"material_select\",\"id\":\"1\",\"path\":\"/secret\"}", replies::add)
        assertTrue(replies.isEmpty()); assertEquals(0, picker.calls)
        call(bridge, replies); assertTrue(JSONObject(replies.single()).getBoolean("cancelled")); assertEquals(0, port.begins); bridge.close()
    }
    @Test fun rejectedAndQueuedExecutorCloseStreamBeforeAnyUpload() {
        for (reject in listOf(true, false)) {
            var closed = false
            val picker = Picker().also { it.selection = listOf(NativeSelection("file", "text/plain", 1,
                object : ByteArrayInputStream(byteArrayOf(1)) { override fun close() { closed = true } })) }
            val port = Port(); val jobs = mutableListOf<() -> Unit>(); val replies = mutableListOf<String>()
            val bridge = MaterialNativeSelectionBridge({ nativeScope }, {}, picker, port,
                { if (reject) throw java.util.concurrent.RejectedExecutionException() else jobs.add(it) }, { it() })
            call(bridge, replies)
            if (!reject) bridge.close()
            assertTrue(closed); jobs.toList().forEach { it() }; assertEquals(0, port.begins)
            if (!reject) assertTrue(replies.isEmpty()) else assertFalse(JSONObject(replies.single()).getBoolean("ok"))
            bridge.close()
        }
    }
    @Test fun unknownSelectionKeepsOriginalIdsAndNeverReopensPicker() {
        val picker = Picker().also { it.selection = listOf(NativeSelection("file", "text/plain", 1, ByteArrayInputStream(byteArrayOf(1)))) }
        val port = Port().also { it.unknown = true }; val replies = mutableListOf<String>()
        val bridge = MaterialNativeSelectionBridge({ nativeScope }, {}, picker, port, { it() }, { it() })
        call(bridge, replies); assertFalse(JSONObject(replies.last()).getBoolean("ok"))
        call(bridge, replies); assertEquals(1, port.begins); assertEquals(1, port.commits); assertEquals(1, picker.calls)
        assertEquals(port.rows.keys.single(), port.queriedIds.single()); bridge.close()
    }
    @Test fun nativeScreenObserverAcceptsOnlyTrustedCursorFreeRegistration() {
        val registrations = mutableListOf<JSONObject>(); val scopes = mutableListOf<String>()
        val observer = MaterialNativeScreenObserver(registrations::add, scopes::add)
        val body = JSONObject().put("screen", nativeScope.screenId).put("token", nativeScope.screenToken).put("label", "Home")
            .put("auth_scope", nativeScope.authScope).put("local_management", true)
        val bytes = "event: screen.registered\ndata: $body\n\n".toByteArray()
        observer.accept(bytes.copyOfRange(0, 13)); observer.accept(bytes.copyOfRange(13, bytes.size))
        observer.accept("id: 42\nevent: screen.registered\ndata: $body\n\n".toByteArray())
        observer.accept("event: auth.scope\ndata: {\"auth_scope\":\"${nativeScope.authScope}\"}\n\n".toByteArray())
        assertEquals(1, registrations.size); assertEquals(listOf(nativeScope.authScope), scopes)
    }
    @Test fun nativeHttpPortSendsRawBytesAndKeepsNonceCredentialsPrivate() {
        val requests = mutableListOf<CoreHttpRequest>(); val nonce = "01234567-89ab-cdef-0123-456789abcdef"
        val transport = CoreHttpTransport { request, _, _ ->
            requests.add(request)
            val result = when (request.url.path.substringAfterLast('/')) {
                "begin" -> JSONObject().put("import_id", "import").put("state", "receiving").put("next_chunk", 0).put("upload_nonce", nonce)
                "commit" -> JSONObject().put("state", "committed").put("selection", JSONObject().put("selection_id", "selected").put("name", "file").put("media_type", "text/plain").put("byte_length", 3).put("sha256", materialHash("abc".toByteArray())))
                else -> JSONObject()
            }
            CoreHttpReply(200, "application/json", JSONObject().put("ok", true).put("result", result).toString().toByteArray())
        }
        val port = MaterialNativeHttpImportPort(4700, { "private-native-bearer" }, "c".repeat(64), {}, transport)
        val cancel = CoreCancellation(); port.begin(nativeScope, "import", NativeSelection("file", "text/plain", 3, ByteArrayInputStream(byteArrayOf())), cancel)
        port.write(nativeScope, "import", 0, "abc".toByteArray(), cancel)
        val fact = port.commit(nativeScope, "import", 3, materialHash("abc".toByteArray()), cancel)
        assertEquals("committed", fact.state)
        val write = requests[1]; assertArrayEquals("abc".toByteArray(), write.body)
        assertEquals("application/octet-stream", write.headers["content-type"]); assertEquals(nonce, write.headers["x-ash-material-nonce"])
        assertEquals(nativeScope.screenToken, write.headers["ash-screen"]); assertEquals("Bearer private-native-bearer", write.headers["authorization"])
        assertTrue(requests.all { it.url.host == "127.0.0.1" && it.url.port == 4700 && it.url.path.startsWith("/api/collaboration/material/native/import/") })
        assertEquals(nonce, JSONObject(requests[2].body!!.toString(Charsets.UTF_8)).getString("upload_nonce"))
    }
    @Test fun genericUiProxyRejectsNativeIngressEncodedNormalizedAndQueryVariants() {
        for (path in listOf("/api/collaboration/material/native/import/begin", "/api/collaboration/material/native/import/query?import_id=chosen",
            "/api/collaboration/material/%6eative/import/begin", "/api/collaboration/material/native%2fimport%2fbegin",
            "/api/collaboration/material/x/../native/import/begin", "/api/collaboration/material/x/%2e%2e/native/import/begin",
            "/API/COLLABORATION/MATERIAL/NATIVE/IMPORT/BEGIN", "/api/collaboration/material/native")) assertTrue(path, materialNativeIngressPath(path))
        assertFalse(materialNativeIngressPath("/api/collaboration/material/ui/currentScope"))
        assertFalse(materialNativeIngressPath("/api/stream?follow=true"))
    }

    @Test fun spoofedLengthAndActualFileLimitNeverCommitNativeSelection() {
        for ((reported, bytes) in listOf(1L to byteArrayOf(1, 2), null to ByteArray(MATERIAL_FILE_BYTES.toInt() + 1))) {
            val picker = Picker().also { it.selection = listOf(NativeSelection("file", "image/png", reported, ByteArrayInputStream(bytes))) }
            val port = Port(); val replies = mutableListOf<String>()
            val bridge = MaterialNativeSelectionBridge({ nativeScope }, {}, picker, port, { it() }, { it() })
            call(bridge, replies); assertFalse(JSONObject(replies.single()).getBoolean("ok")); assertEquals(0, port.commits)
            assertTrue(port.rows.values.single().size().toLong() <= MATERIAL_FILE_BYTES); bridge.close()
        }
    }
    @Test fun scopeReplacementDuringNativeImportClosesStreamsAndSuppressesLatePageReply() {
        var live = nativeScope; var closed = false
        val picker = Picker().also { it.selection = listOf(NativeSelection("file", "text/plain", 1,
            object : ByteArrayInputStream(byteArrayOf(1)) { override fun close() { closed = true } })) }
        val port = Port().also { it.afterWrite = { live = nativeScope.copy(pageEpoch = 2, screenId = "screen:new") } }
        val replies = mutableListOf<String>()
        val bridge = MaterialNativeSelectionBridge({ live }, { check(it == live) }, picker, port, { it() }, { it() })
        call(bridge, replies); assertTrue(closed); assertTrue(replies.isEmpty()); assertEquals(0, port.commits); bridge.close()
    }

    private fun singleCall(bridge: MaterialNativeSelectionBridge, replies: MutableList<String>, extra: String = "") {
        bridge.receive("https://appassets.androidplatform.net", true, 1,
            "{\"type\":\"material_select\",\"id\":\"single\",\"max_files\":1,\"max_file_bytes\":4194304$extra}", replies::add)
    }
    @Test fun singleImageModeImportsOnlyOnePngOrJpegWithVerifiedMetadata() {
        for (mime in listOf("image/png", "image/jpeg")) {
            val bytes = byteArrayOf(1, 2, 3)
            val picker = Picker().also { it.selection = listOf(NativeSelection("photo", mime, 3, ByteArrayInputStream(bytes))) }
            val port = Port(); val replies = mutableListOf<String>()
            val bridge = MaterialNativeSelectionBridge({ nativeScope }, {}, picker, port, { it() }, { it() })
            singleCall(bridge, replies)
            assertEquals(1, picker.maxFiles); assertEquals(1, port.commits)
            val selected = JSONObject(replies.single()).getJSONArray("selections")
            assertEquals(1, selected.length()); assertEquals(mime, selected.getJSONObject(0).getString("media_type"))
            assertEquals(materialHash(bytes), selected.getJSONObject(0).getString("sha256"))
            bridge.close()
        }
    }
    @Test fun singleModeRejectsExtraSourcesWrongMimeAndReportedOversizeBeforeAnyUpload() {
        for ((count, mime, length) in listOf(Triple(2, "image/png", 1L), Triple(1, "text/plain", 1L),
            Triple(1, "image/gif", 1L), Triple(1, "image/jpeg", MATERIAL_FILE_BYTES + 1))) {
            var closes = 0
            val picker = Picker().also { it.selection = List(count) { NativeSelection("photo", mime, length,
                object : ByteArrayInputStream(byteArrayOf(1)) { override fun close() { closes++ } }) } }
            val port = Port(); val replies = mutableListOf<String>()
            val bridge = MaterialNativeSelectionBridge({ nativeScope }, {}, picker, port, { it() }, { it() })
            singleCall(bridge, replies)
            assertFalse(JSONObject(replies.single()).getBoolean("ok")); assertEquals(0, port.begins)
            assertEquals(count, closes); bridge.close()
        }
    }
    @Test fun singleModeStrictSchemaRejectsChosenUriAndInvalidOrStringLimits() {
        val picker = Picker(); val port = Port(); val replies = mutableListOf<String>()
        val bridge = MaterialNativeSelectionBridge({ nativeScope }, {}, picker, port, { it() }, { it() })
        singleCall(bridge, replies, ",\"uri\":\"content://evil\"")
        for (limits in listOf("\"max_files\":2,\"max_file_bytes\":4194304", "\"max_files\":1,\"max_file_bytes\":4194305",
            "\"max_files\":\"1\",\"max_file_bytes\":4194304", "\"max_files\":1,\"max_file_bytes\":\"4194304\"")) {
            bridge.receive("https://appassets.androidplatform.net", true, 1,
                "{\"type\":\"material_select\",\"id\":\"single\",$limits}", replies::add)
        }
        assertEquals(0, picker.calls); assertTrue(replies.isEmpty()); bridge.close()
    }
    @Test fun recoveryIdCannotChangeSelectionMode() {
        val picker = Picker(); val port = Port(); val replies = mutableListOf<String>()
        val bridge = MaterialNativeSelectionBridge({ nativeScope }, {}, picker, port, { it() }, { it() })
        singleCall(bridge, replies); call(bridge, replies, "single")
        assertEquals(1, picker.calls); assertEquals(1, replies.size); bridge.close()
    }

    @Test fun singleImageUnknownLengthStillEnforcesActualFourMiBLimit() {
        val picker = Picker().also { it.selection = listOf(NativeSelection("photo", "image/png", null,
            ByteArrayInputStream(ByteArray(MATERIAL_FILE_BYTES.toInt() + 1)))) }
        val port = Port(); val replies = mutableListOf<String>()
        val bridge = MaterialNativeSelectionBridge({ nativeScope }, {}, picker, port, { it() }, { it() })
        singleCall(bridge, replies)
        assertFalse(JSONObject(replies.single()).getBoolean("ok")); assertEquals(0, port.commits)
        assertTrue(port.rows.values.single().size().toLong() <= MATERIAL_FILE_BYTES); bridge.close()
    }

    @Test fun homeResultAndImagePrechecksClassifyErrorsBeforeUriRead() {
        assertEquals("invalid", materialPickerResultError(1, 2, true))
        assertEquals("invalid", materialPickerResultError(1, 0, true))
        assertEquals("invalid", materialPickerResultError(1, 1, false))
        assertNull(materialPickerResultError(1, 1, true))
        assertNull(materialPickerResultError(4, 4, true))
        assertEquals("unsupported", materialImageSelectionError("text/plain", 1))
        assertEquals("unsupported", materialImageSelectionError("image/gif", 1))
        assertEquals("too_large", materialImageSelectionError("image/png", MATERIAL_FILE_BYTES + 1))
        assertEquals("invalid", materialImageSelectionError("image/jpeg", -1))
        assertNull(materialImageSelectionError("image/png", MATERIAL_FILE_BYTES))
        assertNull(materialImageSelectionError("image/jpeg", null))
    }
    @Test fun nativePrecheckFailureIsNeverCancellationAndRetryKeepsError() {
        for (error in listOf("invalid", "unsupported", "too_large", "offline")) {
            val picker = Picker().also { it.error = error }; val port = Port(); val replies = mutableListOf<String>()
            val bridge = MaterialNativeSelectionBridge({ nativeScope }, {}, picker, port, { it() }, { it() })
            singleCall(bridge, replies); singleCall(bridge, replies)
            replies.forEach { raw ->
                val body = JSONObject(raw)
                assertFalse(body.getBoolean("ok")); assertFalse(body.has("cancelled"))
                assertEquals(error, body.getJSONObject("error").getString("code"))
            }
            assertEquals(1, picker.calls); assertEquals(0, port.begins); bridge.close()
        }
    }

}
