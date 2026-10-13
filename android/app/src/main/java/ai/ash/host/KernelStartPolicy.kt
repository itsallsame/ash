package ai.ash.host

/**
 * When the hand app starts the kernel through the kernel package's no-screen activity instead of (or after) its
 * service. Phones with an "associated start" guard (MIUI WakePath, ColorOS 关联启动) reject one package starting a
 * service of another, quietly or with a refusal, but let an activity start through; Android 12 lets an app start an
 * activity only while one of its windows is in view. So the order is:
 *  1. the service start, always (cheap, and the normal path on every other phone);
 *  2. the activity, when the service start was refused, or went through but the link is still not up [SETTLE_MS] later
 *     (a guard that drops the start without saying so), at most once per [GAP_MS], and only while the app is in front;
 *  3. in the background: nothing more, a line in the log, the owner's next opening of the app tries again.
 * Pure but for its two timestamps; the caller passes the clock.
 */
class KernelStartPolicy(private val settleMs: Long = SETTLE_MS, private val gapMs: Long = GAP_MS) {
    enum class Route {
        /** Nothing to do: the kernel is not installed, or the link is up. */
        NONE,
        /** The service start was enough for now (the kernel may still be coming up). */
        SERVICE,
        /** Start the kernel package's [KernelLauncher.START_ACTIVITY]. */
        ACTIVITY,
        /** The activity would be needed but the app is in the background: only log, the next opening tries again. */
        BACKGROUND,
    }

    private var pendingSince: Long? = null
    private var lastActivityAt: Long? = null

    /**
     * [serviceStarted]: Android accepted the service start just made. [bound]: the link to the kernel is up.
     * [foreground]: one of the app's windows is in view (an activity start is then allowed).
     */
    @Synchronized
    fun route(now: Long, installed: Boolean, bound: Boolean, serviceStarted: Boolean, foreground: Boolean): Route {
        if (!installed) return Route.NONE
        if (bound) { pendingSince = null; return Route.NONE }
        if (serviceStarted) {
            // A wait that began long ago belongs to an earlier outage: this is a new first try.
            val since = pendingSince?.takeIf { now - it < FORGET_MS } ?: now.also { pendingSince = it }
            if (now - since < settleMs) return Route.SERVICE
        }
        if (!foreground) return Route.BACKGROUND
        val last = lastActivityAt
        if (last != null && now - last < gapMs) return Route.SERVICE
        lastActivityAt = now
        return Route.ACTIVITY
    }

    companion object {
        /** How long a service start that Android accepted may take to bring the link up before it is doubted. */
        const val SETTLE_MS = 10_000L
        /** A wait older than this is forgotten. */
        const val FORGET_MS = 60_000L
        /** The least time between two activity starts. */
        const val GAP_MS = 15_000L
    }
}
