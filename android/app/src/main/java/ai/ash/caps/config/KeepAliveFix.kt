package ai.ash.caps.config

import ai.ash.caps.screen.A11yService
import ai.ash.caps.screen.AccessibilityUi
import ai.ash.caps.screen.KeepAliveSwitches
import ai.ash.caps.screen.SwitchFlow
import android.content.Context
import android.os.Build
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Turns on the background-running switches of Ash's own apps in the phone maker's settings, by driving them through
 * the accessibility service ([SwitchFlow]); ColorOS only. Two things start it: the owner's tap ([KeepAliveFlow]) and the
 * capability `config.keepalive.fix`. One run at a time.
 */
object KeepAliveFix {
    private val running = AtomicBoolean(false)

    /** The apps among [packages] that are Ash's and installed; all of Ash's installed apps when [packages] is empty. */
    fun targets(ctx: Context, packages: List<String>): List<KeepAliveSwitches.Target> {
        val asked = if (packages.isEmpty()) KeepAliveSwitches.targets else packages.mapNotNull { KeepAliveSwitches.target(it) }
        return asked.distinctBy { it.pkg }.filter { runCatching { ctx.packageManager.getPackageInfo(it.pkg, 0) }.isSuccess }
    }

    /**
     * The run's report; an unsupported phone gets a report that says so. Null when another run is going. Throws when the
     * accessibility service is off. Blocks for the length of the run (up to a few minutes), so not on the main thread.
     */
    fun run(ctx: Context, asked: List<KeepAliveSwitches.Target>): KeepAliveSwitches.Report? {
        if (!SwitchFlow.supported(Build.MANUFACTURER)) return KeepAliveSwitches.Report(KeepAliveSwitches.Outcome.UNSUPPORTED, "", emptyList())
        if (!running.compareAndSet(false, true)) return null
        try {
            val service = A11yService.instance ?: throw IllegalStateException("the accessibility service is off (Settings → Accessibility → Ash)")
            return SwitchFlow(AccessibilityUi(service, service), asked).run()
        } finally { running.set(false) }
    }
}
