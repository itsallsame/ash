package ai.ash.ui

/**
 * The owner comes back from a system settings page: what they switched there may not show yet (some phones report a change a
 * moment late), so the state is read at once and again a few times within three seconds. One run replaces the one before it.
 */
class ReturnRecheck(private val scheduler: Scheduler, private val check: () -> Unit) {
    /** Where a delayed call is made; the screens give a main-thread handler. */
    interface Scheduler {
        fun postDelayed(task: Runnable, ms: Long)
        fun cancel(task: Runnable)
    }

    private val pending = mutableListOf<Runnable>()

    /** Reads now and after each of [DELAYS_MS]; anything still waiting from an earlier run is dropped first. */
    fun start() {
        cancel()
        for (ms in DELAYS_MS) {
            if (ms == 0L) { check(); continue }
            val task = object : Runnable { override fun run() { pending.remove(this); check() } }
            pending += task
            scheduler.postDelayed(task, ms)
        }
    }

    fun cancel() {
        pending.forEach { scheduler.cancel(it) }
        pending.clear()
    }

    companion object {
        /** Right away, then after half a second, a second and a half, three seconds. */
        val DELAYS_MS = longArrayOf(0, 500, 1_500, 3_000)
    }
}
