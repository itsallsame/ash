package ai.ash.caps.config

import ai.ash.caps.Capabilities
import ai.ash.caps.screen.Screen
import ai.ash.host.Notifications
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.provider.Settings
import org.json.JSONObject

/**
 * An upgrade makes the system switch off the app's accessibility service (SPEC-05 §7). After it, if the owner had the
 * service on, Ash turns it back on itself when it holds WRITE_SECURE_SETTINGS (`config.accessibility.enable`), and
 * otherwise asks the owner in a notice to switch it on. A service the owner never turned on, or turned off, is left off.
 */
object UpgradeRecovery {
    private const val PREFS = "ash.upgrade"
    private const val NOTICE = "upgrade-a11y"

    enum class Action { NOTHING, ENABLE, ASK_OWNER }
    enum class Outcome { LEFT_ALONE, ENABLED, ASKED }

    /** What to do once the upgrade is done: [wanted] the owner had the service on before; [running] it is on now. */
    fun plan(wanted: Boolean, running: Boolean, secureGranted: Boolean): Action = when {
        !wanted || running -> Action.NOTHING
        secureGranted -> Action.ENABLE
        else -> Action.ASK_OWNER
    }

    /** The phone, as far as the recovery needs it. */
    interface Env {
        fun wanted(): Boolean
        fun running(): Boolean
        fun secureGranted(): Boolean
        /** Turns the service on; true once it is running. */
        fun enable(): Boolean
        fun askOwner()
        fun sleep(ms: Long)
    }

    /**
     * Runs after the package was replaced. The system may restore the service by itself a moment later, so it is given
     * [settleMs] to do so before anything is changed.
     */
    fun run(env: Env, settleMs: Long = 6_000, stepMs: Long = 500): Outcome {
        if (!env.wanted()) return Outcome.LEFT_ALONE
        var waited = 0L
        while (!env.running() && waited < settleMs) { env.sleep(stepMs); waited += stepMs }
        return when (plan(true, env.running(), env.secureGranted())) {
            Action.NOTHING -> Outcome.LEFT_ALONE
            Action.ENABLE -> if (env.enable()) Outcome.ENABLED else { env.askOwner(); Outcome.ASKED }
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
        override fun secureGranted() = ScreenRecovery.granted(ctx)
        override fun enable(): Boolean {
            val result = Capabilities.call(ctx, "config.accessibility.enable", JSONObject()).toJson()
            return result.optBoolean("ok") && result.optJSONObject("data")?.optBoolean("enabled") == true
        }
        override fun askOwner() {
            val tap = PendingIntent.getActivity(ctx, 3, Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            Notifications.notice(ctx, NOTICE, "Ash 需要你点一下", "更新后系统关掉了 Ash 的无障碍，点这里在列表里把「Ash」重新打开", tap)
        }
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
