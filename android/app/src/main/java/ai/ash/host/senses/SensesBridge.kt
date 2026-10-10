package ai.ash.host.senses

import ai.ash.host.CoreClient
import ai.ash.host.cap.CapResult
import ai.ash.host.cap.Capability
import ai.ash.senses.SenseCapabilities
import ai.ash.senses.SenseHost
import ai.ash.senses.SenseLink
import ai.ash.senses.SetupActivity
import ai.ash.senses.Senses
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Ash's face to the senses (location, motion, steps and health, recorded inside this same app). Their tools join the
 * phone's manifest (each needs a policy of Ash's to be offered). The rows they record arrive here in batches and go on
 * to the core as sense.* events, the way the phone's other senses do; a batch is acknowledged only once the core took it.
 */
object SensesBridge {
    private const val TAG = "ash.senses"
    private val delivery = Executors.newSingleThreadExecutor { Thread(it, "ash-senses-delivery") }
    @Volatile private var app: Context? = null

    fun start(ctx: Context) {
        app = ctx.applicationContext
        Senses.init(ctx)
        // Whatever was recorded while Ash was not running is offered now.
        SenseLink.flush(resendAll = true)
    }

    /** A batch of newly recorded rows: {batch_id, word, body}. */
    fun senseBatch(batch: String) {
        val ctx = app ?: runCatching { Senses.ctx() }.getOrNull() ?: return
        delivery.execute { deliver(ctx, batch) }
    }

    /** One batch to the core; acknowledged only once the core took it (otherwise it is offered again). */
    private fun deliver(ctx: Context, raw: String) {
        val event = SensesEvents.parse(raw)
        if (event == null) {
            // Never deliverable: acknowledged so it does not come back forever, and logged.
            val id = runCatching { JSONObject(raw).optString("batch_id") }.getOrDefault("")
            Log.w(TAG, "dropped a malformed senses batch ${id.take(40)}")
            if (id.isNotBlank()) SenseLink.ack(id)
            return
        }
        try {
            CoreClient(ctx).sendSense(event.word, event.body, event.id)
            SenseLink.ack(event.id)
        } catch (e: Exception) {
            Log.w(TAG, "senses batch not delivered yet: ${e.javaClass.simpleName}: ${e.message?.take(80)}")
        }
    }

    /** The core is back: batches it missed are offered again. */
    fun pull() { SenseLink.flush(resendAll = true) }

    fun status(): JSONObject = app?.let { SenseLink.status(it) } ?: JSONObject()
    private val tools: List<Capability> by lazy { SenseCapabilities.list.map { SenseTool(it) } }
    fun tools(): List<Capability> = tools

    /** The senses' own page, where the owner grants each permission and source. */
    fun openSetup(a: Activity) {
        a.startActivity(Intent(a, SetupActivity::class.java))
    }

    fun call(name: String, args: JSONObject): CapResult {
        val ctx = app ?: return CapResult.fail("$name is not available right now: Ash has not started")
        return SenseHost.run(ctx, name, args)
    }

    /** One of the senses tools, as Ash's capability. */
    private class SenseTool(real: Capability) : Capability {
        override val name: String = real.name
        override val description: String = real.description
        override val schema: JSONObject = real.schema
        override val confirm: Boolean = real.confirm
        override fun available(ctx: Context) = true
        override fun run(ctx: Context, args: JSONObject) = call(name, args)
    }
}
