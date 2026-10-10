package ai.ash.kernel

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager

/** The system's alarm clock, as the wake capability needs it. */
interface AlarmPort {
    /** One alarm only: a new one replaces the old. */
    fun set(atMs: Long)
    fun cancel()
}

/**
 * wake.at / wake.clear. The host keeps at most one alarm, the earliest asked for: a later time while an earlier alarm
 * is pending changes nothing (the core re-arms after every wake.fired). When the alarm fires the core hears wake.fired.
 */
class WakeManager(private val alarms: AlarmPort) {
    private var pending: Long? = null

    @Synchronized
    fun at(atMs: Long) {
        val p = pending
        if (p != null && p <= atMs) return
        pending = atMs
        alarms.set(atMs)
    }

    @Synchronized
    fun clear() {
        pending = null
        alarms.cancel()
    }

    /** The alarm for [atMs] went off. */
    @Synchronized
    fun fired(atMs: Long) {
        if (pending == atMs) pending = null
    }

    @Synchronized
    fun pending(): Long? = pending
}

/** Wake locks, as the power capability and the timer need them. */
interface PowerPort {
    /** Hold the CPU awake for [ms] at most (released by [release] earlier). */
    fun hold(ms: Long, reason: String)
    fun release()
}

class AndroidAlarms(private val ctx: Context) : AlarmPort {
    private fun intent(atMs: Long?): PendingIntent {
        val i = Intent(ctx, WakeReceiver::class.java)
        if (atMs != null) i.putExtra(WakeReceiver.EXTRA_AT, atMs)
        return PendingIntent.getBroadcast(ctx, REQUEST, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    override fun set(atMs: Long) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val pi = intent(atMs)
        val t = maxOf(System.currentTimeMillis() + 1000, atMs)
        try {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t, pi)
        } catch (_: SecurityException) {
            // Exact alarms are optional; an inexact one still wakes from doze and the core's own timer stays the truth.
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t, pi)
        }
    }

    override fun cancel() {
        ctx.getSystemService(AlarmManager::class.java).cancel(intent(null))
    }

    private companion object { const val REQUEST = 7 }
}

/** Two partial wake locks: one the core asks for (power.hold), one the timer takes when its alarm fires. */
class AndroidPower(ctx: Context) : PowerPort {
    private val pm = ctx.getSystemService(PowerManager::class.java)
    private val hold = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ash-kernel:hold").apply { setReferenceCounted(false) }
    private val timer = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ash-kernel:timer").apply { setReferenceCounted(false) }

    override fun hold(ms: Long, reason: String) { hold.acquire(ms) }

    override fun release() { if (hold.isHeld) hold.release() }

    /** The alarm went off: keep the CPU for the turn the core is about to run. */
    fun holdForTimer() { timer.acquire(TIMER_HOLD_MS) }

    companion object {
        const val TIMER_HOLD_MS = 3 * 60_000L

        @Volatile private var instance: AndroidPower? = null
        fun get(ctx: Context): AndroidPower = instance ?: synchronized(this) {
            instance ?: AndroidPower(ctx.applicationContext).also { instance = it }
        }
    }
}
