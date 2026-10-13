package ai.ash.host.screen

import ai.ash.caps.config.ScreenRecovery
import ai.ash.host.TaskStatus
import ai.ash.screen.island.NativeIsland
import ai.ash.ui.HomeActivity
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/**
 * Ash's side of the task island, which the accessibility service draws: one layer. What the island shows comes from the
 * task status the kernel presents (`present` on the `island` / `status` surfaces, see [ai.ash.human.HumanChannel]); what the
 * owner does on it comes back through [NativeIsland.Ash] to [TaskStatus]. The screen tools are capabilities
 * ([ai.ash.caps.screen.ScreenCapabilities]), not part of this.
 *
 * [attach] must have run before anything is presented: it gives this layer the app context (the island cannot be drawn
 * or asked about without it). [ai.ash.host.HandRuntime.start] does it, and a `present` handler calls that first.
 */
object ScreenBridge : NativeIsland.Ash {
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var app: Context? = null
    private var lastIsland = ""
    /** The frame the island shows now, kept to draw it again when it may be shown again (main thread). */
    private var model: JSONObject? = null

    init { NativeIsland.ash = this }

    /** Gives the island the app context; idempotent and cheap, safe from any thread. */
    fun attach(ctx: Context) { app = ctx.applicationContext }

    fun start(ctx: Context) {
        attach(ctx)
        main.post { lastIsland = ""; TaskStatus.refresh() }
        ScreenRecovery.start(ctx)
    }

    /** The accessibility service came or went, or the island appeared or left. */
    fun changed() {
        main.post { TaskStatus.refresh() }
        // The screen tools are offered only while the accessibility service runs: the kernel is told the new manifest.
        ai.ash.link.Link.manifestChanged()
    }

    /**
     * The accessibility service connected, went away, or was reconnected (the system does so, e.g. while a testing tool
     * holds the screen): the island's windows went with the old one, so it is drawn again here, from the last frame.
     */
    fun serviceChanged() {
        changed()
        main.post { app?.let { apply(it) } }
    }

    // ---- the island ----

    /** The island can be drawn (the accessibility service, or the overlay permission). */
    fun islandReady() = app?.let { NativeIsland.ready(it) } ?: false
    fun islandShown() = NativeIsland.showing()

    /** What the island shows (null = nothing). Drawn when it changes, and once more after a restart of the screen service. */
    fun island(shown: JSONObject?, ashInFront: Boolean) {
        val ctx = app ?: return
        val key = "${shown ?: "-"}|$ashInFront"
        if (key == lastIsland) return
        lastIsland = key
        val frame = shown?.let { JSONObject(it.toString()) }
        main.post {
            NativeIsland.ashInFront = ashInFront
            model = frame
            if (frame == null) NativeIsland.hide() else apply(ctx)
        }
    }

    /** The latest frame again (the island re-applies it when it may be shown again, or after a local answer). */
    private fun apply(ctx: Context) {
        val m = model ?: return
        NativeIsland.update(ctx, JSONObject(m.toString())) { main.post { apply(ctx) } }
    }

    // ---- what the owner did on the island ----

    override fun dismiss(turn: String) { main.post { TaskStatus.dismiss(turn) } }
    override fun stop(turn: String) { main.post { TaskStatus.stop(turn) } }
    override fun revokeLease() { main.post { app?.let { ai.ash.ui.LeaseState.revoke(it) } } }
    override fun open() { main.post { app?.let { it.startActivity(Intent(it, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) } } }
    override fun answer(id: String, choice: String, text: String?, done: (Boolean, String) -> Unit) { main.post { TaskStatus.answerCard(id, choice, text, done) } }
    override fun send(text: String, clientId: String, done: (Boolean, String) -> Unit) { main.post { TaskStatus.sendInput(text, clientId, done) } }
    override fun shown(value: Boolean) = changed()
}
