package ai.ash.kernel

import android.content.Context

/** The one thing that outlives the process: whether the owner asked the kernel to stay stopped. Tokens are per start, in memory. */
class Secrets(ctx: Context) {
    private val prefs = ctx.getSharedPreferences("ash.kernel", Context.MODE_PRIVATE)

    var stopped: Boolean
        get() = prefs.getBoolean("stopped", false)
        set(v) { prefs.edit().putBoolean("stopped", v).apply() }
}
