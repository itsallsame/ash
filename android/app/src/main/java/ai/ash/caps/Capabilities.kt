package ai.ash.caps

import android.content.Context
import android.util.Log
import org.json.JSONObject
import ai.ash.caps.browser.BrowserCapabilities
import ai.ash.caps.calendar.CalendarCapabilities
import ai.ash.caps.media.MediaCapabilities
import ai.ash.caps.shell.ShellCapabilities
import ai.ash.caps.system.SystemCapabilities
import ai.ash.caps.vscreen.VScreenCapabilities

/** The phone's capability registry: what the device channel's manifest lists and its calls run. */
object Capabilities {
    private const val TAG = "ash.cap"

    /** Every module contributes its list here (system, screen/accessibility, shell/Shizuku, virtual screen). */
    val all: List<Capability> by lazy {
        SystemCapabilities.list + ShellCapabilities.list + VScreenCapabilities.list + CalendarCapabilities.list + BrowserCapabilities.list + MediaCapabilities.list
    }
    /**
     * Ash's own, and the screen tools ([ai.ash.host.screen.ScreenBridge]) and the senses tools
     * ([ai.ash.caps.senses.SensesBridge]), which live in this same app.
     */
    private fun current(): List<Capability> = all + ai.ash.host.screen.ScreenBridge.tools() + ai.ash.caps.senses.SensesBridge.tools()

    /**
     * The capabilities that can work right now, each with Ash's policy for it. Ash sets what a tool may do to the
     * owner, whoever runs it: a tool Ash has no policy for is not offered. The device channel's manifest is made from this.
     */
    fun offered(ctx: Context): List<Pair<Capability, CapabilityPolicy>> {
        val out = ArrayList<Pair<Capability, CapabilityPolicy>>()
        for (c in current()) {
            val ok = try { c.available(ctx) } catch (e: Throwable) { false }
            if (!ok) continue
            val policy = runCatching { CapabilityPolicies.require(c.name) }.getOrNull()
            if (policy == null) { Log.w(TAG, "no policy for ${c.name}"); continue }
            out.add(c to policy)
        }
        return out
    }

    fun call(ctx: Context, name: String, args: JSONObject): CapResult {
        val c = current().firstOrNull { it.name == name } ?: return CapResult.fail("the phone has no capability $name")
        if (!c.available(ctx)) return CapResult.fail("$name is not available right now (a permission or service is off on the phone)")
        return try {
            c.run(ctx, args)
        } catch (e: Throwable) {
            Log.w(TAG, "$name failed", e)
            CapResult.fail("$name failed: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    fun deviceName(): String {
        val m = android.os.Build.MODEL ?: "Android"
        val b = android.os.Build.MANUFACTURER ?: ""
        return if (m.startsWith(b, ignoreCase = true)) "手机 · $m" else "手机 · $b $m"
    }
}
