package ai.ash.caps.senses

import ai.ash.BuildConfig
import ai.ash.caps.Events
import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * What the senses (location, motion, steps, health, recorded inside this same app) tell the kernel: the rows they record
 * are batched ([SenseStore.collect]) and each batch goes on as a `sense.*` device event ([Events]) with the batch id as
 * the event id. The link queues the event durably and sends it again after a reconnect until the kernel acks it, so a
 * batch is done with the moment the queue holds it: it is acknowledged in the store then. A batch the queue refused stays
 * in the store and is offered at the next [flush]. The senses' tools are the [SenseCapabilities] in the capability registry.
 */
object SenseSync {
    private const val TAG = "ash.senses"
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "senses-sync") }

    fun start(ctx: Context) {
        Senses.init(ctx)
        // Whatever was recorded while Ash was not running is offered now.
        flush()
    }

    /** New rows were recorded: batch them and hand every batch to the link. */
    fun flush() { runCatching { executor.execute { send() } } }

    private fun send() {
        try {
            val ctx = Senses.ctx()
            val store = Senses.store
            store.collect(System.currentTimeMillis())
            for (b in store.outbox()) {
                try {
                    Events.emit(ctx, b.word, b.body, b.id)
                    store.ack(b.id)
                } catch (e: Exception) {
                    Log.w(TAG, "senses batch not queued yet: ${e.javaClass.simpleName}: ${e.message?.take(80)}")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "batches not delivered: ${e.javaClass.simpleName}")
        }
    }

    /** {version, recording, permissions, sources, pending_batches, ...}. */
    fun status(ctx: Context): JSONObject {
        val config = Senses.config(ctx)
        return JSONObject().put("version", BuildConfig.VERSION_CODE).put("recording", config.recording).put("recorder_running", Recorder.running())
            .put("config", config.toJson()).put("permissions", Senses.permissions(ctx)).put("location_on", Senses.locationOn(ctx))
            .put("step_counter", StepReader.available(ctx)).put("pending_batches", runCatching { Senses.store.pendingBatches() }.getOrDefault(0L))
            .put("location", runCatching { LocationReader.status(ctx) }.getOrElse { JSONObject().put("error", it.toString()) })
            .apply { Recorder.lastProblem?.let { put("problem", it) } }
    }
}
