package ai.ash.caps.system

import ai.ash.caps.hostshell.HostShell
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import android.provider.Settings

/** What a start did: how it went out, and what the phone showed afterwards (when that could be read). */
class Launch(
    /** "direct" or "host_shell". */
    val via: String,
    /** The package asked for (null when the intent names none). */
    val expected: String?,
    /** The package in front afterwards, when it could be read. */
    val front: String?,
    /** True: [expected] is in front. False: something else is. Null: could not be checked. */
    val confirmed: Boolean?,
) {
    val opened: Boolean get() = confirmed != false

    /** One sentence for the capability's reply. */
    fun summary(): String {
        val route = if (via == "host_shell") " through the phone's debug identity" else ""
        return when (confirmed) {
            true -> "started$route and confirmed in front ($front)"
            false -> "the start command ran$route, but the app in front is $front, not $expected " +
                "(it may still be loading, the screen may be locked, or a dialog may cover it)"
            null -> "started$route" + if (front != null) " (the app in front is $front)" else " (could not check the screen afterwards)"
        }
    }
}

/** A start that did not happen: [code] is a unified error code, [hint] says what the owner can do. */
class LaunchFailure(val code: String, message: String, val hint: String? = null) : Exception(message)

/**
 * Starts activities for capabilities, which run in the background (the hand app's process). Since Android 10,
 * background activity starts are silently dropped unless an exemption applies: Ash has a visible window, Ash's
 * accessibility service is enabled (bound by the system), or (before Android 15) Ash may draw overlays. Otherwise
 * the start goes through the phone's debug identity (`am start` as the shell user is always allowed). The order is in [LaunchRoute].
 * When none of these holds the start fails with what the owner can turn on, never with a vague "requested".
 */
object Launcher {
    /** @throws LaunchFailure when the activity could not be started. */
    fun start(ctx: Context, intent: Intent): Launch {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val expected = expectedPackage(ctx, intent)
        val sdk = Build.VERSION.SDK_INT
        return when (LaunchRoute.choose(sdk, isForeground(ctx), accessibilityEnabled(ctx), canOverlay(ctx), hostShellStatus(ctx))) {
            LaunchRoute.Way.FOREGROUND -> direct(ctx, intent, expected, retryThroughHostShell = false)
            LaunchRoute.Way.EXEMPT -> direct(ctx, intent, expected, retryThroughHostShell = true)
            LaunchRoute.Way.HOST_SHELL -> viaHostShell(ctx, intent, expected)
            LaunchRoute.Way.BLOCKED -> throw LaunchFailure(
                "unavailable",
                "cannot open the screen: Android ${Build.VERSION.RELEASE} blocks apps in the background from starting screens, " +
                    "and Ash has no way around it right now (no accessibility service, no overlay permission, debug identity not connected)",
                LaunchRoute.hint(hostShellStatus(ctx)),
            )
        }
    }

    private fun direct(ctx: Context, intent: Intent, expected: String?, retryThroughHostShell: Boolean): Launch {
        val before = if (retryThroughHostShell) frontPackage(ctx) else null
        try { ctx.startActivity(intent) } catch (e: Throwable) {
            throw LaunchFailure("failed", "could not start the screen: ${e.message ?: e.javaClass.simpleName}")
        }
        val front = awaitFront(ctx, expected)
        val confirmed = LaunchRoute.confirmed(expected, front)
        // Some phone makers (MIUI/ColorOS) drop the start even when the exemption holds: nothing changed on the screen, so go around it.
        if (confirmed == false && retryThroughHostShell && front != null && front == before && HostShell.ready()) {
            return viaHostShell(ctx, intent, expected)
        }
        return Launch("direct", expected, front, confirmed)
    }

    private fun viaHostShell(ctx: Context, intent: Intent, expected: String?): Launch {
        try { HostShell.start(intent) } catch (e: Throwable) {
            throw LaunchFailure("failed", "could not start through the phone's debug identity: ${e.message ?: e.javaClass.simpleName}")
        }
        val front = awaitFront(ctx, expected)
        return Launch("host_shell", expected, front, LaunchRoute.confirmed(expected, front))
    }

    /** The package the intent should bring up: its component or package, else the one the system resolves it to. */
    fun expectedPackage(ctx: Context, intent: Intent): String? {
        intent.component?.packageName?.let { return it }
        intent.`package`?.let { return it }
        val resolved = try { ctx.packageManager.resolveActivity(intent, 0)?.activityInfo?.packageName } catch (e: Throwable) { null }
        return resolved?.takeIf { it != "android" }
    }

    /** Reads the front package for a short while until it is [expected] (an app takes a moment to come up). */
    private fun awaitFront(ctx: Context, expected: String?): String? {
        if (!canSee(ctx)) return null
        var front: String? = null
        val tries = if (expected == null) 1 else 5
        for (i in 0 until tries) {
            try { Thread.sleep(if (i == 0) 700 else 500) } catch (e: InterruptedException) { Thread.currentThread().interrupt(); break }
            front = frontPackage(ctx)
            if (expected == null || front == expected) break
        }
        return front
    }

    /** Whether the screen can be read after a start: the debug identity (dumpsys) or Ash's accessibility service. */
    private fun canSee(@Suppress("UNUSED_PARAMETER") ctx: Context): Boolean = HostShell.ready() || ai.ash.caps.screen.A11yService.instance != null

    /** The package in front now, from the debug identity when connected, else from the accessibility service; null when neither can say. */
    fun frontPackage(@Suppress("UNUSED_PARAMETER") ctx: Context): String? {
        if (HostShell.ready()) runCatching { HostShell.frontApp() }.getOrNull()?.let { return it }
        return try { ai.ash.caps.screen.A11yService.instance?.foregroundPackage()?.ifEmpty { null } } catch (e: Throwable) { null }
    }

    fun hostShellStatus(ctx: Context): HostShellStatus = when (HostShell.state(ctx)) {
        HostShell.State.READY -> HostShellStatus.READY
        HostShell.State.ABSENT -> HostShellStatus.ABSENT
        HostShell.State.NOT_PAIRED -> HostShellStatus.NOT_PAIRED
    }

    /** Ash can start an activity itself (in front, or exempt), without the debug identity. */
    fun canStartDirectly(ctx: Context): Boolean =
        LaunchRoute.direct(Build.VERSION.SDK_INT, isForeground(ctx), accessibilityEnabled(ctx), canOverlay(ctx))

    private fun canOverlay(ctx: Context): Boolean = try { Settings.canDrawOverlays(ctx) } catch (e: Throwable) { false }

    fun isForeground(ctx: Context): Boolean = try {
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        am.runningAppProcesses?.any { it.pid == Process.myPid() && it.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND } == true
    } catch (e: Throwable) { false }

    fun accessibilityEnabled(ctx: Context): Boolean = try {
        val s = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
        s.split(':').any { it.startsWith(ctx.packageName + "/") }
    } catch (e: Throwable) { false }
}
