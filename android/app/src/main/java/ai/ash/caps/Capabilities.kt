package ai.ash.caps

import ai.ash.caps.browser.BrowserCapabilities
import ai.ash.caps.calendar.CalendarCapabilities
import ai.ash.caps.config.ConfigCapabilities
import ai.ash.caps.decision.DecisionCapabilities
import ai.ash.caps.media.MediaCapabilities
import ai.ash.caps.screen.Screen
import ai.ash.caps.screen.ScreenCapabilities
import ai.ash.caps.senses.SenseCapabilities
import ai.ash.caps.shell.ShellCapabilities
import ai.ash.caps.system.SystemCapabilities
import ai.ash.caps.vscreen.VScreenCapabilities
import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * The phone's capability registry, the one place the hand's contract comes from: the device channel's manifest is made
 * from it ([Manifest]) and the kernel's calls run through it ([call]). Each module lists its own capabilities with
 * their schemas, effect, risk and label; nothing else declares a capability.
 */
object Capabilities {
    private const val TAG = "ash.cap"

    /** Every module contributes its list here. */
    val all: List<Capability> by lazy {
        val list = SystemCapabilities.list + ShellCapabilities.list + VScreenCapabilities.list + CalendarCapabilities.list + BrowserCapabilities.list +
            MediaCapabilities.list + ScreenCapabilities.list + SenseCapabilities.list + ConfigCapabilities.list + DecisionCapabilities.list
        val names = list.map { it.name }
        require(names.size == names.toSet().size) { "a capability is declared twice: ${names.groupBy { it }.filterValues { it.size > 1 }.keys}" }
        list
    }

    val byName: Map<String, Capability> by lazy { all.associateBy { it.name } }

    /** The capabilities that can work right now; the device channel's manifest is made from these. */
    fun offered(ctx: Context): List<Capability> = all.filter {
        try { it.available(ctx) } catch (e: Throwable) { Log.w(TAG, "${it.name}: availability check failed", e); false }
    }

    /**
     * Runs one capability, on the calling thread (the link's worker; never the main thread). [turn] is the agent turn the
     * call was made in, when it was made in one. Every failure comes back as a failed [CapResult], never as an exception.
     */
    fun call(ctx: Context, name: String, args: JSONObject, turn: String = ""): CapResult {
        val c = byName[name] ?: return CapResult.fail("the phone has no capability $name")
        if (!c.available(ctx)) return CapResult.fail("$name is not available right now (a permission or service is off on the phone)")
        val run = {
            try {
                c.run(ctx, args, turn)
            } catch (e: Throwable) {
                Log.w(TAG, "$name failed", e)
                CapResult.fail("$name failed: ${e.message ?: e.javaClass.simpleName}")
            }
        }
        // The island steps aside for a capture and lets Ash's input to other apps pass under it; it refuses while the owner types.
        return try {
            when (c.overlay) {
                Overlay.NONE -> run()
                Overlay.PASSTHROUGH -> Screen.withTouchPassthrough(run)
                Overlay.HIDDEN -> if (args.optInt("display", 0) != 0) run() else Screen.withoutOverlay(run)
            }
        } catch (e: IllegalStateException) {
            CapResult.fail(e.message ?: "owner_input_busy")
        }
    }

    fun deviceName(): String {
        val m = android.os.Build.MODEL ?: "Android"
        val b = android.os.Build.MANUFACTURER ?: ""
        return if (m.startsWith(b, ignoreCase = true)) "手机 · $m" else "手机 · $b $m"
    }
}
