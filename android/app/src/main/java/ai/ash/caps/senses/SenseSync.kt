package ai.ash.caps.senses

import ai.ash.BuildConfig
import ai.ash.caps.Events
import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * What the senses (location, motion, steps, health, recorded inside this same app) tell the kernel: the rows they record
 * are batched and go on as `sense.*` device events ([Events]). A batch is kept in the [SenseStore] until it is
 * acknowledged, and acknowledged once the link's event queue holds it (the queue keeps it until the kernel acks it), so
 * a batch the app could not hand over is offered again later and nothing recorded is lost to a restart. At most a few
 * batches are in flight at once. The senses' tools are the [SenseCapabilities] in the capability registry.
 */
object SenseSync {
    private const val TAG = "ash.senses"
    const val IN_FLIGHT = 4
    const val RESEND_MS = 5 * 60_000L

    private val executor = Executors.newSingleThreadExecutor { Thread(it, "senses-sync") }
    private val delivery = Executors.newSingleThreadExecutor { Thread(it, "ash-senses-delivery") }
    @Volatile private var app: Context? = null

    fun start(ctx: Context) {
        app = ctx.applicationContext
        Senses.init(ctx)
        // Whatever was recorded while Ash was not running is offered now.
        flush(resendAll = true)
    }

    /** The kernel is back: batches not acknowledged are offered again. */
    fun pull() { flush(resendAll = true) }

    /** New rows (or the kernel asking): batch them and offer what is due. */
    fun flush(resendAll: Boolean = false) { runCatching { executor.execute { send(resendAll) } } }

    /** Delivery took the batch onward: the store forgets it. */
    private fun ack(id: String) { executor.execute { runCatching { Senses.store.ack(id) }; send(resendAll = false) } }

    private fun send(resendAll: Boolean) {
        try {
            val store = Senses.store
            val now = System.currentTimeMillis()
            store.collect(now)
            val batches = store.outbox()
            val inFlight = if (resendAll) 0 else batches.count { it.sentAt > 0 && now - it.sentAt < RESEND_MS }
            var budget = IN_FLIGHT - inFlight
            for (b in batches) {
                if (budget <= 0) break
                if (!resendAll && b.sentAt > 0 && now - b.sentAt < RESEND_MS) continue
                offer(Batches.envelope(b.id, b.word, b.body).toString())
                store.markSent(b.id, now)
                budget--
            }
        } catch (e: Exception) {
            Log.w(TAG, "batches not delivered: ${e.javaClass.simpleName}")
        }
    }

    /** A batch of newly recorded rows: {batch_id, word, body}. */
    private fun offer(batch: String) {
        val ctx = app ?: runCatching { Senses.ctx() }.getOrNull() ?: return
        delivery.execute { deliver(ctx, batch) }
    }

    /** One batch into the link's event queue; acknowledged once the queue holds it (otherwise it is offered again). */
    private fun deliver(ctx: Context, raw: String) {
        val event = SensesEvents.parse(raw)
        if (event == null) {
            // Never deliverable: acknowledged so it does not come back forever, and logged.
            val id = runCatching { JSONObject(raw).optString("batch_id") }.getOrDefault("")
            Log.w(TAG, "dropped a malformed senses batch ${id.take(40)}")
            if (id.isNotBlank()) ack(id)
            return
        }
        try {
            Events.emit(ctx, event.word, event.body, event.id)
            ack(event.id)
        } catch (e: Exception) {
            Log.w(TAG, "senses batch not delivered yet: ${e.javaClass.simpleName}: ${e.message?.take(80)}")
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
