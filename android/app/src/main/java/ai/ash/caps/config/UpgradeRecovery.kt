package ai.ash.caps.config

import ai.ash.caps.screen.Screen
import ai.ash.host.Notifications
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock

/**
 * An upgrade makes the system switch off the app's accessibility service (SPEC-05 §7). After it, if the owner had the
 * service on, Ash asks them in a notice to switch it on again (the accessibility service is the owner's to turn on; Ash
 * writes no setting). A service the owner never turned on, or turned off, is left off.
 */
object UpgradeRecovery {
    private const val PREFS = "ash.upgrade"
    private const val NOTICE = "upgrade-a11y"

    enum class Action { NOTHING, ASK_OWNER }
    enum class Outcome { LEFT_ALONE, ASKED }

    /** What to do once the upgrade is done: [wanted] the owner had the service on before; [running] it is on now. */
    fun plan(wanted: Boolean, running: Boolean): Action = if (!wanted || running) Action.NOTHING else Action.ASK_OWNER

    /** The phone, as far as the recovery needs it. */
    interface Env {
        fun wanted(): Boolean
        fun running(): Boolean
        fun askOwner()
        fun sleep(ms: Long)
    }

    /**
     * Runs after the package was replaced. The system may restore the service by itself a moment later, so it is given
     * [settleMs] to do so before the owner is asked.
     */
    fun run(env: Env, settleMs: Long = 6_000, stepMs: Long = 500): Outcome {
        if (!env.wanted()) return Outcome.LEFT_ALONE
        var waited = 0L
        while (!env.running() && waited < settleMs) { env.sleep(stepMs); waited += stepMs }
        return when (plan(true, env.running())) {
            Action.NOTHING -> Outcome.LEFT_ALONE
            Action.ASK_OWNER -> { env.askOwner(); Outcome.ASKED }
        }
    }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    fun wanted(ctx: Context) = prefs(ctx).getBoolean("wanted", false)

    /** Kept up to date by [ScreenRecovery]'s check while the app lives: on while the service runs, off once the owner switched it off. */
    internal fun observe(ctx: Context, running: Boolean, switchedOn: Boolean) {
        when {
            running -> { if (!wanted(ctx)) prefs(ctx).edit().putBoolean("wanted", true).apply(); Notifications.cancelNotice(ctx, NOTICE) }
            !switchedOn -> if (wanted(ctx)) prefs(ctx).edit().putBoolean("wanted", false).apply()
        }
    }

    internal fun android(ctx: Context) = object : Env {
        override fun wanted() = wanted(ctx)
        override fun running() = Screen.accessibility()
        override fun askOwner() = ScreenRecovery.askOwner(ctx, "Ash 需要你点一下", "更新后系统关掉了 Ash 的无障碍，点这里在列表里把「Ash」重新打开", NOTICE)
        override fun sleep(ms: Long) = SystemClock.sleep(ms)
    }
}

/** `MY_PACKAGE_REPLACED`: the app was upgraded; see [UpgradeRecovery]. */
class PackageReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val app = ctx.applicationContext
        val pending = goAsync()
        Thread({ try { UpgradeRecovery.run(UpgradeRecovery.android(app)) } finally { pending.finish() } }, "ash-upgrade-recovery").start()
    }
}
