package ai.ash.kernel

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Starts the kernel after boot and after this package is updated (not after a force-stop: Android sends nothing then). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        Log.i("ash.kernel.boot", "${intent.action}: starting the kernel")
        KernelService.start(ctx)
        // Paired with wireless debugging, but the shell host is gone after a reboot: ask the owner to connect it again.
        if (ai.ash.kernel.host.adb.AdbKey.exists(ctx) && !ai.ash.kernel.host.KernelHost.ready()) {
            ai.ash.kernel.host.KernelPairing.askToConnect(ctx.applicationContext)
        }
    }
}

/** The exact alarm of wake.at went off: take the wake lock first, then let the service tell the core. */
class WakeReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        AndroidPower.get(ctx).holdForTimer()
        KernelService.start(ctx, KernelService.ACTION_WAKE, intent.getLongExtra(EXTRA_AT, 0L))
    }

    companion object { const val EXTRA_AT = "at" }
}

/**
 * Start/stop/restart from tooling: `adb shell am broadcast -n ai.ash.kernel/.ControlReceiver -a ai.ash.kernel.RESTART`.
 * Guarded by android.permission.DUMP, which only the shell and the system hold. (The hand app uses the service's own
 * actions, which need ai.ash.permission.KERNEL.)
 */
class ControlReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.action) {
            KernelService.ACTION_START, KernelService.ACTION_STOP, KernelService.ACTION_RESTART -> KernelService.start(ctx, intent.action)
        }
    }
}
