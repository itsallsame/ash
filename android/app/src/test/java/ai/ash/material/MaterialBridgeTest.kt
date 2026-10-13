package ai.ash.material

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream

class MaterialBridgeTest {
    private class Authority : MaterialAuthority {
        var live = MaterialBinding(1, "screen", "principal", "request", "custody", "generation")
        override fun binding() = live
        override fun current(binding: MaterialBinding) { check(binding == live) }
    }
    private class Core : MaterialCorePort {
        val begunImportIds = mutableListOf<String>(); val queriedImportIds = mutableListOf<String>()
        var begins = 0; var writes = 0; var commits = 0; var queries = 0; var consumes = 0; var consumeQueries = 0
        var lostAck = false; var phone = true; var unknown = false; val queriedConsumeIds = mutableListOf<String>(); val consumedIds = mutableListOf<String>(); var chunkHook: (() -> Unit)? = null
        val bytes = ByteArrayOutputStream()
        var fact = ImportFact(ImportState.UNKNOWN, null, null, false)
        override fun beginImport(binding: MaterialBinding, importId: String, metadata: SelectionMetadata) { begins++; begunImportIds.add(importId) }
        override fun writeChunk(binding: MaterialBinding, importId: String, index: Int, bytes: ByteArray) {
            require(bytes.size <= MATERIAL_CHUNK_BYTES); writes++; this.bytes.write(bytes); chunkHook?.invoke()
        }
        override fun commitImport(binding: MaterialBinding, importId: String, byteLength: Long, sha256: String): ImportFact {
            commits++; require(byteLength == bytes.size().toLong() && sha256 == materialHash(bytes.toByteArray()))
            fact = ImportFact(if (unknown) ImportState.UNKNOWN else ImportState.COMMITTED, byteLength, sha256, phone)
            if (lostAck) error("ack lost"); return fact
        }
        override fun queryImport(binding: MaterialBinding, importId: String): ImportFact { queries++; queriedImportIds.add(importId); return fact }
        override fun read(binding: MaterialBinding, assetId: String, assetVersion: Int, resultVersion: Int): ControlledMaterial {
            val value = "controlled bytes".toByteArray(); return ControlledMaterial(ByteArrayInputStream(value), value.size.toLong(), materialHash(value))
        }
        override fun consume(binding: MaterialBinding, resultVersion: Int, consumeId: String): ConsumeFact { consumes++; consumedIds.add(consumeId); return if (unknown) ConsumeFact.UNKNOWN else ConsumeFact.CONSUMED }
        override fun queryConsume(binding: MaterialBinding, resultVersion: Int, consumeId: String): ConsumeFact { consumeQueries++; queriedConsumeIds.add(consumeId); return if (unknown) ConsumeFact.UNKNOWN else ConsumeFact.CONSUMED }
    }
    private class Picker : MaterialNativePicker {
        var next: NativeSelection? = null
        var pending: ((NativeSelection?) -> Unit)? = null
        var delay = false
        var destination = ByteArrayOutputStream()
        override fun select(done: (NativeSelection?) -> Unit) { if (delay) pending = done else done(next) }
        override fun export(name: String, mediaType: String, done: (java.io.OutputStream?) -> Unit) { done(destination) }
    }
    private fun fails(action: () -> Unit) { try { action(); fail("expected rejection") } catch (_: IllegalStateException) {} catch (_: IllegalArgumentException) {} }
    @Test fun importsActualBoundedBytesAndRecoversLostCommitAckWithoutUpload() {
        val auth = Authority(); val core = Core().also { it.lostAck = true }; val imports = MaterialImport(auth, core)
        val bytes = ByteArray(MATERIAL_CHUNK_BYTES + 3) { 42 }
        val selection = imports.select(auth.live, "file.txt", "text/plain", bytes.size.toLong(), ByteArrayInputStream(bytes))
        assertEquals(ImportState.COMMITTED, imports.import(auth.live, selection.selectionId).state)
        assertEquals(ImportState.COMMITTED, imports.import(auth.live, selection.selectionId).state)
        assertEquals(1, core.begins); assertEquals(2, core.writes); assertEquals(1, core.commits); assertEquals(2, core.queries)
    }
    @Test fun spoofedSizeAndActualLimitCannotCommit() {
        for ((reported, count) in listOf(1L to 2, null to (MATERIAL_FILE_BYTES.toInt() + 1))) {
            val auth = Authority(); val core = Core(); val imports = MaterialImport(auth, core)
            val selected = imports.select(auth.live, "file", "text/plain", reported, ByteArrayInputStream(ByteArray(count)))
            fails { imports.import(auth.live, selected.selectionId) }; assertEquals(0, core.commits)
        }
    }
    @Test fun totalRequestLimitAndUnknownImportNeverRestartUpload() {
        val auth = Authority(); val core = Core(); val imports = MaterialImport(auth, core)
        repeat(3) {
            val selected = imports.select(auth.live, "file", "text/plain", null, ByteArrayInputStream(ByteArray(MATERIAL_FILE_BYTES.toInt())))
            if (it < 2) imports.import(auth.live, selected.selectionId) else {
                fails { imports.import(auth.live, selected.selectionId) }; val begins = core.begins
                assertEquals(ImportState.COMMITTED, core.fact.state)
                // No restart even after uncertain/failed upload; stale proof for a different length is rejected.
                fails { imports.import(auth.live, selected.selectionId) }; assertEquals(begins, core.begins)
            }
            core.bytes.reset()
        }
    }
    @Test fun interruptClosesStreamAndRejectsLateImportFact() {
        val auth = Authority(); val core = Core(); val imports = MaterialImport(auth, core)
        var closed = false
        val stream = object : ByteArrayInputStream(ByteArray(100)) { override fun close() { closed = true; super.close() } }
        val selected = imports.select(auth.live, "file", "text/plain", null, stream)
        val old = auth.live
        core.chunkHook = { auth.live = old.copy(pageEpoch = 2); imports.close() }
        fails { imports.import(old, selected.selectionId) }
        assertTrue(closed); assertEquals(0, core.commits)
        fails { imports.query(auth.live, selected.selectionId) }
    }
    @Test fun cancelAndWrongOriginFrameEpochUnknownFieldsHaveNoUpload() {
        val auth = Authority(); val core = Core(); val picker = Picker()
        val bridge = MaterialUiBridge(auth, core, picker, { it() }, { it() }, { java.util.Base64.getEncoder().encodeToString(it) })
        val replies = mutableListOf<String>()
        val select = "{\"type\":\"material_select\",\"id\":\"1\"}"
        bridge.receive("https://evil.example", true, 1, select, replies::add)
        bridge.receive("https://appassets.androidplatform.net", false, 1, select, replies::add)
        bridge.receive("https://appassets.androidplatform.net", true, 2, select, replies::add)
        bridge.receive("https://appassets.androidplatform.net", true, 1, "{\"type\":\"material_select\",\"id\":\"1\",\"uri\":\"content://evil\"}", replies::add)
        assertTrue(replies.isEmpty())
        bridge.receive("https://appassets.androidplatform.net", true, 1, select, replies::add)
        assertTrue(JSONObject(replies.single()).getBoolean("cancelled")); assertEquals(0, core.begins)
    }
    @Test fun explicitVersionOnceHandleAndScopeRejectReuse() {
        val auth = Authority(); val core = Core(); val picker = Picker(); val replies = mutableListOf<String>()
        val bridge = MaterialUiBridge(auth, core, picker, { it() }, { it() }, { java.util.Base64.getEncoder().encodeToString(it) })
        fun call(json: String) { bridge.receive("https://appassets.androidplatform.net", true, auth.live.pageEpoch, json, replies::add) }
        call("{\"type\":\"material_read\",\"id\":\"r\",\"request_id\":\"request\",\"asset_id\":\"a\",\"asset_version\":1,\"result_version\":2}")
        val handle = JSONObject(replies.last()).getString("consume_handle")
        call("{\"type\":\"material_consume\",\"id\":\"c\",\"request_id\":\"request\",\"consume_handle\":\"$handle\",\"result_version\":1}")
        assertEquals(0, core.consumes)
        val consume = "{\"type\":\"material_consume\",\"id\":\"c\",\"request_id\":\"request\",\"consume_handle\":\"$handle\",\"result_version\":2}"
        call(consume); call(consume); assertEquals(1, core.consumes); assertEquals(1, core.consumeQueries)
        auth.live = auth.live.copy(screenId = "other"); call(consume); assertEquals(1, core.consumes)
    }
    @Test fun delayedPickerAndQueuedWorkAreClosedAfterNavigation() {
        val auth = Authority(); val core = Core(); val picker = Picker().also { it.delay = true }
        val work = mutableListOf<() -> Unit>(); val replies = mutableListOf<String>()
        val bridge = MaterialUiBridge(auth, core, picker, { work.add(it) }, { it() }, { java.util.Base64.getEncoder().encodeToString(it) })
        var closed = false
        val stream = object : ByteArrayInputStream(byteArrayOf(1)) { override fun close() { closed = true } }
        bridge.receive("https://appassets.androidplatform.net", true, 1, "{\"type\":\"material_select\",\"id\":\"s\"}", replies::add)
        picker.pending!!(NativeSelection("file", "text/plain", 1, stream))
        bridge.close(); assertTrue(closed); auth.live = auth.live.copy(pageEpoch = 2)
        work.forEach { it() }; assertTrue(closed); assertTrue(replies.isEmpty()); assertEquals(0, core.begins)
    }
    @Test fun selectionHandleAndMetadataAreBoundToNativeScope() {
        val auth = Authority(); val core = Core(); val imports = MaterialImport(auth, core)
        fails { imports.select(auth.live, "../../secret", "text/plain", 1, ByteArrayInputStream(byteArrayOf(1))) }
        fails { imports.select(auth.live, "file", "not a MIME", 1, ByteArrayInputStream(byteArrayOf(1))) }
        fails { imports.select(auth.live, "file", "text/plain", MATERIAL_FILE_BYTES + 1, ByteArrayInputStream(byteArrayOf(1))) }
        val selected = imports.select(auth.live, "file", "text/plain", 1, ByteArrayInputStream(byteArrayOf(1)))
        auth.live = auth.live.copy(principalId = "other")
        fails { imports.import(auth.live, selected.selectionId) }; assertEquals(0, core.begins)
    }
    @Test fun remoteCoreCommitDoesNotClaimPhoneArrival() {
        val auth = Authority(); val core = Core().also { it.phone = false }
        val picker = Picker().also { it.next = NativeSelection("file", "text/plain", 1, ByteArrayInputStream(byteArrayOf(1))) }
        val replies = mutableListOf<String>(); val bridge = MaterialUiBridge(auth, core, picker, { it() }, { it() }, { java.util.Base64.getEncoder().encodeToString(it) })
        bridge.receive("https://appassets.androidplatform.net", true, 1, "{\"type\":\"material_select\",\"id\":\"s\"}", replies::add)
        val handle = JSONObject(replies.last()).getString("selection_id")
        bridge.receive("https://appassets.androidplatform.net", true, 1, "{\"type\":\"material_import\",\"id\":\"i\",\"selection_id\":\"$handle\"}", replies::add)
        assertFalse(JSONObject(replies.last()).getBoolean("phone_arrived"))
    }
    @Test fun exportVerifiesControlledBytesDoesNotConsume() {
        val auth = Authority(); val core = Core(); val picker = Picker(); val replies = mutableListOf<String>()
        val bridge = MaterialUiBridge(auth, core, picker, { it() }, { it() }, { java.util.Base64.getEncoder().encodeToString(it) })
        bridge.receive("https://appassets.androidplatform.net", true, 1,
            "{\"type\":\"material_export\",\"id\":\"e\",\"request_id\":\"request\",\"asset_id\":\"a\",\"asset_version\":1,\"result_version\":2,\"name\":\"file.txt\",\"media_type\":\"text/plain\"}", replies::add)
        assertEquals("controlled bytes", picker.destination.toString("UTF-8"))
        assertTrue(JSONObject(replies.single()).getBoolean("exported")); assertEquals(0, core.consumes)
    }
    @Test fun importTerminalAndExpiredSelectionsRecycleActiveSlots() {
        val auth = Authority(); val core = Core(); var clock = 1L
        val imports = MaterialImport(auth, core, { clock })
        repeat(12) {
            val selected = imports.select(auth.live, "file", "text/plain", 1, ByteArrayInputStream(byteArrayOf(1)))
            imports.import(auth.live, selected.selectionId); core.bytes.reset()
        }
        var closed = 0
        val handles = (1..4).map {
            imports.select(auth.live, "file", "text/plain", 1,
                object : ByteArrayInputStream(byteArrayOf(1)) { override fun close() { closed++ } }).selectionId
        }
        clock += 300_000_000_001L
        imports.select(auth.live, "fifth", "text/plain", 1, ByteArrayInputStream(byteArrayOf(1)))
        assertEquals(4, closed)
        handles.forEach { fails { imports.import(auth.live, it) } }
        imports.close()
    }
    @Test fun failedImportsFreeSlotsAndUnknownFactsOnlyQueryOriginalOperation() {
        val auth = Authority(); val core = Core().also { it.unknown = true }; val imports = MaterialImport(auth, core)
        repeat(6) {
            val selected = imports.select(auth.live, "file", "text/plain", 2, ByteArrayInputStream(byteArrayOf(1)))
            fails { imports.import(auth.live, selected.selectionId) }; core.bytes.reset()
        }
        val selected = imports.select(auth.live, "file", "text/plain", 1, ByteArrayInputStream(byteArrayOf(1)))
        assertEquals(ImportState.UNKNOWN, imports.import(auth.live, selected.selectionId).state)
        val begins = core.begins; val writes = core.writes
        assertEquals(ImportState.UNKNOWN, imports.import(auth.live, selected.selectionId).state)
        assertEquals(begins, core.begins); assertEquals(writes, core.writes); imports.close()
    }
    @Test fun readConsumedAndExpiredHandlesDoNotPermanentlyFillEightSlots() {
        val auth = Authority(); val core = Core(); val picker = Picker(); var clock = 1L
        val replies = mutableListOf<String>()
        val bridge = MaterialUiBridge(auth, core, picker, { it() }, { it() }, { java.util.Base64.getEncoder().encodeToString(it) }, { clock })
        fun call(type: String, fields: String) {
            bridge.receive("https://appassets.androidplatform.net", true, 1,
                "{\"type\":\"$type\",\"id\":\"i\",\"request_id\":\"request\",$fields}", replies::add)
        }
        repeat(12) {
            call("material_read", "\"asset_id\":\"a\",\"asset_version\":1,\"result_version\":2")
            val handle = JSONObject(replies.last()).getString("consume_handle")
            call("material_consume", "\"consume_handle\":\"$handle\",\"result_version\":2")
            assertTrue(JSONObject(replies.last()).getBoolean("ok"))
        }
        repeat(8) { call("material_read", "\"asset_id\":\"a\",\"asset_version\":1,\"result_version\":2") }
        val expired = JSONObject(replies.last()).getString("consume_handle")
        clock += 300_000_000_001L
        call("material_read", "\"asset_id\":\"a\",\"asset_version\":1,\"result_version\":2")
        assertTrue(JSONObject(replies.last()).getBoolean("ok"))
        call("material_consume", "\"consume_handle\":\"$expired\",\"result_version\":2")
        assertFalse(JSONObject(replies.last()).getBoolean("ok")); assertEquals(12, core.consumes); bridge.close()
    }
    @Test fun rejectedExecutorImmediatelyClosesPickerAndExportStreams() {
        val auth = Authority(); val core = Core(); val picker = Picker(); var selectionClosed = false; var exportClosed = false
        picker.next = NativeSelection("file", "text/plain", 1,
            object : ByteArrayInputStream(byteArrayOf(1)) { override fun close() { selectionClosed = true } })
        picker.destination = object : ByteArrayOutputStream() { override fun close() { exportClosed = true } }
        val replies = mutableListOf<String>()
        val bridge = MaterialUiBridge(auth, core, picker, { throw java.util.concurrent.RejectedExecutionException() }, { it() })
        bridge.receive("https://appassets.androidplatform.net", true, 1, "{\"type\":\"material_select\",\"id\":\"s\"}", replies::add)
        assertTrue(selectionClosed); assertFalse(JSONObject(replies.last()).getBoolean("ok"))
        bridge.receive("https://appassets.androidplatform.net", true, 1,
            "{\"type\":\"material_export\",\"id\":\"e\",\"request_id\":\"request\",\"asset_id\":\"a\",\"asset_version\":1,\"result_version\":2,\"name\":\"file\",\"media_type\":\"text/plain\"}", replies::add)
        assertTrue(exportClosed); assertFalse(JSONObject(replies.last()).getBoolean("ok")); assertEquals(0, core.begins); bridge.close()
    }
    @Test fun queuedExportIsClosedImmediatelyAndLateRunnerCannotWrite() {
        val auth = Authority(); val core = Core(); val picker = Picker(); var exportClosed = false
        picker.destination = object : ByteArrayOutputStream() { override fun close() { exportClosed = true } }
        val jobs = mutableListOf<() -> Unit>(); val replies = mutableListOf<String>()
        val bridge = MaterialUiBridge(auth, core, picker, { jobs.add(it) }, { it() })
        bridge.receive("https://appassets.androidplatform.net", true, 1,
            "{\"type\":\"material_export\",\"id\":\"e\",\"request_id\":\"request\",\"asset_id\":\"a\",\"asset_version\":1,\"result_version\":2,\"name\":\"file\",\"media_type\":\"text/plain\"}", replies::add)
        bridge.close(); assertTrue(exportClosed); jobs.forEach { it() }
        assertEquals(0, picker.destination.size()); assertTrue(replies.isEmpty())
    }
    @Test fun unknownConsumeRetainsOnceIdAcrossSlotRecyclingAndClosedBridgeRejectsOldHandle() {
        val auth = Authority(); val core = Core().also { it.unknown = true }; val picker = Picker(); val replies = mutableListOf<String>()
        val bridge = MaterialUiBridge(auth, core, picker, { it() }, { it() }, { java.util.Base64.getEncoder().encodeToString(it) })
        fun call(type: String, fields: String) {
            bridge.receive("https://appassets.androidplatform.net", true, 1,
                "{\"type\":\"$type\",\"id\":\"i\",\"request_id\":\"request\",$fields}", replies::add)
        }
        call("material_read", "\"asset_id\":\"a\",\"asset_version\":1,\"result_version\":2")
        val handle = JSONObject(replies.last()).getString("consume_handle")
        val fields = "\"consume_handle\":\"$handle\",\"result_version\":2"
        call("material_consume", fields)
        repeat(12) {
            call("material_read", "\"asset_id\":\"a\",\"asset_version\":1,\"result_version\":2")
            val other = JSONObject(replies.last()).getString("consume_handle")
            call("material_consume", "\"consume_handle\":\"$other\",\"result_version\":2")
        }
        call("material_consume", fields)
        assertEquals(core.consumedIds.first(), core.queriedConsumeIds.single()); assertEquals(13, core.consumes)
        bridge.close()
        val reopened = MaterialUiBridge(auth, core, picker, { it() }, { it() })
        reopened.receive("https://appassets.androidplatform.net", true, 1,
            "{\"type\":\"material_consume\",\"id\":\"i\",\"request_id\":\"request\",$fields}", replies::add)
        assertFalse(JSONObject(replies.last()).getBoolean("ok")); assertEquals(13, core.consumes); reopened.close()
    }

    @Test fun fullImportMetadataRejectsNewSelectionAndRetainsUnknownStableId() {
        val auth = Authority(); val core = Core().also { it.unknown = true }; val imports = MaterialImport(auth, core)
        var original = ""
        repeat(64) {
            val selected = imports.select(auth.live, "file", "text/plain", 1, ByteArrayInputStream(byteArrayOf(1)))
            if (it == 0) original = selected.selectionId
            assertEquals(ImportState.UNKNOWN, imports.import(auth.live, selected.selectionId).state)
            core.bytes.reset()
        }
        var rejectedClosed = false
        fails { imports.select(auth.live, "sixty-fifth", "text/plain", 1,
            object : ByteArrayInputStream(byteArrayOf(1)) { override fun close() { rejectedClosed = true } }) }
        assertTrue(rejectedClosed)
        assertEquals(ImportState.UNKNOWN, imports.import(auth.live, original).state)
        assertEquals(original, core.queriedImportIds.single()); assertEquals(64, core.begins); assertEquals(64, core.writes)
        imports.close()
    }
    @Test fun fullConsumeHistoryRejectsNewConsumeAndRetainsUnknownOnceId() {
        val auth = Authority(); val core = Core().also { it.unknown = true }; val picker = Picker(); val replies = mutableListOf<String>()
        val bridge = MaterialUiBridge(auth, core, picker, { it() }, { it() }, { java.util.Base64.getEncoder().encodeToString(it) })
        fun call(type: String, fields: String) {
            bridge.receive("https://appassets.androidplatform.net", true, 1,
                "{\"type\":\"$type\",\"id\":\"i\",\"request_id\":\"request\",$fields}", replies::add)
        }
        var original = ""
        repeat(64) {
            call("material_read", "\"asset_id\":\"a\",\"asset_version\":1,\"result_version\":2")
            val handle = JSONObject(replies.last()).getString("consume_handle")
            if (it == 0) original = handle
            call("material_consume", "\"consume_handle\":\"$handle\",\"result_version\":2")
            assertEquals("unknown", JSONObject(replies.last()).getString("state"))
        }
        call("material_read", "\"asset_id\":\"a\",\"asset_version\":1,\"result_version\":2")
        val extra = JSONObject(replies.last()).getString("consume_handle")
        call("material_consume", "\"consume_handle\":\"$extra\",\"result_version\":2")
        assertFalse(JSONObject(replies.last()).getBoolean("ok")); assertEquals(64, core.consumes)
        call("material_consume", "\"consume_handle\":\"$original\",\"result_version\":2")
        assertEquals("unknown", JSONObject(replies.last()).getString("state"))
        assertEquals(core.consumedIds.first(), core.queriedConsumeIds.single()); assertEquals(64, core.consumes)
        bridge.close()
    }

}
