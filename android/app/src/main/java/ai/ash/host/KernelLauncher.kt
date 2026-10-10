package ai.ash.host

import ai.ash.link.HandService
import ai.ash.link.Link
import ai.ash.link.LinkClient
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
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
    /** The kernel package's no-screen activity that starts the service; guarded by the signature permission `ai.ash.permission.KERNEL`. */
    const val START_ACTIVITY = "ai.ash.kernel.StartActivity"
    const val ACTION_START = "ai.ash.kernel.START"
    const val ACTION_STOP = "ai.ash.kernel.STOP"
    const val ACTION_RESTART = "ai.ash.kernel.RESTART"

    /** The kernel package's version name, or null when it is not installed (or not visible to this app). */
    fun installedVersion(ctx: Context): String? =
        try { ctx.packageManager.getPackageInfo(PACKAGE, 0).versionName ?: "?" } catch (_: PackageManager.NameNotFoundException) { null }

    /** Whether the link to the kernel is up now. */
    fun connected(ctx: Context): Boolean = Link.get(ctx).client.state == LinkClient.State.READY

    /** Not installed, installed but not running, or bound (the kernel host holds [ai.ash.link.HandService], or the link is up). */
    fun state(ctx: Context): KernelState =
        KernelGate.state(installedVersion(ctx) != null, HandService.bound || connected(ctx))

    private val policy = KernelStartPolicy()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var recheckPosted = false

    /**
     * Starts the kernel's service (a foreground service), with one of the service's own actions if given. False when
     * the kernel is not installed or nothing could be started; never throws.
     *
     * Order ([KernelStartPolicy]): the service start; if the phone refuses it (or accepts it but the link stays down),
     * the kernel package's no-screen [START_ACTIVITY], which a phone's associated-start guard lets through, but only
     * while the app is in front. In the background that is not tried: only logged, the owner's next opening retries.
     * Only a plain start (no action) falls back to the activity, which takes no parameters; start, stop and restart with an action need the service itself.
     */
    fun start(ctx: Context, action: String? = null): Boolean = start(ctx, action, recheck = true)

    private fun start(ctx: Context, action: String?, recheck: Boolean): Boolean {
        val app = ctx.applicationContext
        val installed = installedVersion(app) != null
        val intent = Intent().setComponent(ComponentName(PACKAGE, SERVICE)).setAction(action)
        val serviceStarted = installed && try {
            app.startForegroundService(intent) != null
        } catch (e: Exception) {
            Log.w(TAG, "could not start the kernel: ${e.javaClass.simpleName}")
            false
        }
        if (action != null) return serviceStarted
        return when (policy.route(SystemClock.elapsedRealtime(), installed, state(app) == KernelState.BOUND, serviceStarted, BackgroundLaunch.visible)) {
            KernelStartPolicy.Route.NONE -> serviceStarted
            KernelStartPolicy.Route.SERVICE -> { if (recheck) recheckLater(app); serviceStarted }
            KernelStartPolicy.Route.ACTIVITY -> startActivity(app) || serviceStarted
            KernelStartPolicy.Route.BACKGROUND -> { Log.i(TAG, "the kernel is not up and the app is in the background: not starting its activity, waiting for the owner to open the app"); serviceStarted }
        }
    }

    /** A service start the phone accepted gets one look a little later: if the link is still down by then, the activity is tried (a guard may drop the start quietly). */
    private fun recheckLater(app: Context) {
        if (recheckPosted) return
        recheckPosted = true
        main.postDelayed({
            recheckPosted = false
            if (state(app) == KernelState.NOT_RUNNING) start(app, null, recheck = false)
        }, KernelStartPolicy.SETTLE_MS + 500)
    }

    private fun startActivity(app: Context): Boolean = try {
        app.startActivity(Intent().setComponent(ComponentName(PACKAGE, START_ACTIVITY)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION))
        Log.i(TAG, "started the kernel through its start activity")
        true
    } catch (e: Exception) {
        // An older kernel package without the activity, or the system refused: nothing more to try.
        Log.w(TAG, "could not start the kernel's start activity: ${e.javaClass.simpleName}")
        false
    }
}
