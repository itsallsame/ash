package ai.ash.senses

import ai.ash.BuildConfig
import ai.ash.host.cap.CapResult
import ai.ash.host.senses.SensesBridge
import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.Executors

/** The senses tools, inside Ash: [SensesBridge] is the face the rest of Ash uses; this is what it calls. */
object SenseHost {
    fun run(ctx: Context, name: String, args: JSONObject): CapResult {
        Senses.init(ctx)
        val c = SenseCapabilities.list.firstOrNull { it.name == name } ?: return CapResult.fail("the phone has no capability $name")
        return try { c.run(ctx, args) }
        catch (e: SenseError) { e.result() }
        catch (e: Throwable) {
            Log.w("ash.senses", "$name failed", e)
            CapResult.fail("$name failed: ${e.message ?: e.javaClass.simpleName}")
        }
    }
}

/**
 * Batches of newly recorded rows go to Ash's delivery ([SensesBridge]), each kept until it is acknowledged. A batch not
 * acknowledged is offered again later (the core may have been down), so nothing recorded is lost to a restart. At most
 * a few batches are in flight at once.
 */
object SenseLink {
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "senses-ash-link") }
    const val IN_FLIGHT = 4
    const val RESEND_MS = 5 * 60_000L

    /** Delivery took the batch onward: the store forgets it. */
    fun ack(id: String) { executor.execute { runCatching { Senses.store.ack(id) }; send(resendAll = false) } }

    /** New rows (or the core asking): batch them and offer what is due. */
    fun flush(resendAll: Boolean = false) { runCatching { executor.execute { send(resendAll) } } }

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
                SensesBridge.senseBatch(Batches.envelope(b.id, b.word, b.body).toString())
                store.markSent(b.id, now)
                budget--
            }
        } catch (e: Exception) {
            Log.w("ash.senses", "batches not delivered: ${e.javaClass.simpleName}")
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
