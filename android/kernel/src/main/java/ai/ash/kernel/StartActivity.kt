package ai.ash.kernel

import android.app.Activity
import android.os.Bundle
import android.util.Log

/**
 * A way to start the kernel for phones whose "associated start" guard (MIUI WakePath, ColorOS 关联启动) rejects another
 * package starting or binding a service but lets an activity start through. It has no screen and does one thing:
 * start [KernelService] as a foreground service, then finish.
 *
 * Abuse: it is exported but guarded by the signature permission `ai.ash.permission.KERNEL`, so only an app signed with
 * the same key (the hand app) can start it; it reads nothing from the intent that started it (no action, no extras, no
 * data), so a caller cannot steer it; and it can only do what any start of the service does (the service itself
 * ignores an unknown action, and a stopped kernel stays stopped).
 */
class StartActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            KernelService.start(this)
        } catch (e: Exception) {
            Log.w("ash.kernel", "could not start the service from StartActivity: ${e.javaClass.simpleName}")
        }
        finish()
    }
}
