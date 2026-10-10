package ai.ash.host

import ai.ash.link.Link
import ai.ash.link.LinkClient
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log

/**
 * The hand app never runs the core itself. When the kernel package (`ai.ash.kernel`) is not running, this asks it to
 * start: a start intent for its `KernelService`, which needs `ai.ash.permission.KERNEL` (SPEC-04 §4, SPEC-05 §4).
 * Once running, the kernel binds [ai.ash.link.HandService] and hands over the link's port and token.
 */
object KernelLauncher {
    private const val TAG = "ash.kernel"
    const val PACKAGE = "ai.ash.kernel"
    private const val SERVICE = "ai.ash.kernel.KernelService"
    const val ACTION_START = "ai.ash.kernel.START"
    const val ACTION_STOP = "ai.ash.kernel.STOP"
    const val ACTION_RESTART = "ai.ash.kernel.RESTART"

    /** The kernel package's version name, or null when it is not installed (or not visible to this app). */
    fun installedVersion(ctx: Context): String? =
        try { ctx.packageManager.getPackageInfo(PACKAGE, 0).versionName ?: "?" } catch (_: PackageManager.NameNotFoundException) { null }

    /** Whether the link to the kernel is up now. */
    fun connected(ctx: Context): Boolean = Link.get(ctx).client.state == LinkClient.State.READY

    /**
     * Starts the kernel's service (a foreground service), with one of the service's own actions if given.
     * False when the kernel is not installed or Android refuses the start (the app is in the background with no
     * exemption); never throws.
     */
    fun start(ctx: Context, action: String? = null): Boolean {
        val intent = Intent().setComponent(ComponentName(PACKAGE, SERVICE)).setAction(action)
        return try {
            ctx.startForegroundService(intent) != null
        } catch (e: Exception) {
            Log.w(TAG, "could not start the kernel: ${e.javaClass.simpleName}")
            false
        }
    }
}
