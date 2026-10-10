package ai.ash.caps.system

import ai.ash.caps.shell.PrivShell
import ai.ash.caps.shell.ShizukuState
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import android.provider.Settings

/** What a start did: how it went out, and what the phone showed afterwards (when that could be read). */
class Launch(
    /** "direct" or "shizuku". */
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
        val route = if (via == "shizuku") " through Shizuku" else ""
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
 * the start goes through the Shizuku shell (`am start`; the shell is always allowed). The order is in [LaunchRoute].
 * When none of these holds the start fails with what the owner can turn on, never with a vague "requested".
 */
object Launcher {
    private const val ASK_TIMEOUT_MS = 25_000L

    /** @throws LaunchFailure when the activity could not be started. */
    fun start(ctx: Context, intent: Intent): Launch {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val expected = expectedPackage(ctx, intent)
        val sdk = Build.VERSION.SDK_INT
        val fg = isForeground(ctx)
        val a11y = accessibilityEnabled(ctx)
        val overlay = canOverlay(ctx)
        var asked = false
        var way = LaunchRoute.choose(sdk, fg, a11y, overlay) { shizukuStatus(ctx, wait = true) }
        if (way == LaunchRoute.Way.ASK_SHIZUKU) {
            // Shizuku runs but Ash is not authorized: show Shizuku's permission dialog and wait for the owner.
            asked = true
            ShizukuState.requestPermission(ASK_TIMEOUT_MS)
            way = LaunchRoute.choose(sdk, fg, a11y, overlay) { shizukuStatus(ctx, wait = false) }
        }
        return when (way) {
            LaunchRoute.Way.FOREGROUND -> direct(ctx, intent, expected, retryThroughShizuku = false)
            LaunchRoute.Way.EXEMPT -> direct(ctx, intent, expected, retryThroughShizuku = true)
            LaunchRoute.Way.SHIZUKU -> viaShizuku(ctx, intent, expected)
            else -> {
                val status = shizukuStatus(ctx, wait = false)
                throw LaunchFailure(
                    "unavailable",
                    "cannot open the screen: Android ${Build.VERSION.RELEASE} blocks apps in the background from starting screens, " +
                        "and Ash has no way around it right now (no accessibility service, no overlay permission, Shizuku not ready" +
                        (if (asked) "; the Shizuku authorization was not given" else "") + ")",
                    LaunchRoute.hint(status, asked),
                )
            }
        }
    }

    private fun direct(ctx: Context, intent: Intent, expected: String?, retryThroughShizuku: Boolean): Launch {
        val before = if (retryThroughShizuku) frontPackage(ctx) else null
        try { ctx.startActivity(intent) } catch (e: Throwable) {
            throw LaunchFailure("failed", "could not start the screen: ${e.message ?: e.javaClass.simpleName}")
        }
        val front = awaitFront(ctx, expected)
        val confirmed = LaunchRoute.confirmed(expected, front)
        // Some phone makers (MIUI/ColorOS) drop the start even when the exemption holds: nothing changed on the screen, so go around it.
        if (confirmed == false && retryThroughShizuku && front != null && front == before && ShizukuState.ready()) {
            return viaShizuku(ctx, intent, expected)
        }
        return Launch("direct", expected, front, confirmed)
    }

    private fun viaShizuku(ctx: Context, intent: Intent, expected: String?): Launch {
        val cmd = amStart(intent)
        val r = try { PrivShell.exec(ctx, cmd, 15_000, via = "shizuku") } catch (e: Throwable) {
            throw LaunchFailure("failed", "could not run the start through Shizuku: ${e.message ?: e.javaClass.simpleName}")
        }
        val out = (r.stdout + "\n" + r.stderr).trim()
        if (r.timedOut || out.contains("Error:") || out.contains("Exception")) {
            throw LaunchFailure("failed", "am start failed: ${out.ifEmpty { "exit ${r.exitCode}" }.take(600)}")
        }
        val front = awaitFront(ctx, expected)
        return Launch("shizuku", expected, front, LaunchRoute.confirmed(expected, front))
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

    /** Whether the screen can be read after a start: Shizuku (dumpsys) or Ash's accessibility service. */
    private fun canSee(ctx: Context): Boolean = ShizukuState.ready() || ai.ash.caps.screen.A11yService.instance != null

    /** The package in front now, from Shizuku when ready, else from the accessibility service; null when neither can say. */
    fun frontPackage(ctx: Context): String? {
        if (ShizukuState.ready()) {
            val r = try { PrivShell.exec(ctx, LaunchRoute.FRONT_COMMAND, 6_000, via = "shizuku") } catch (e: Throwable) { null }
            LaunchRoute.parseFront(r?.stdout.orEmpty())?.let { return it }
        }
        return try { ai.ash.caps.screen.A11yService.instance?.foregroundPackage()?.ifEmpty { null } } catch (e: Throwable) { null }
    }

    /** Where Shizuku stands; with [wait] a binder that has not arrived yet (cold start) is waited for a few seconds. */
    fun shizukuStatus(ctx: Context, wait: Boolean): ShizukuStatus {
        if (ShizukuState.ready()) return ShizukuStatus.READY
        val installed = ShizukuState.installed(ctx)
        if (wait && installed) ShizukuState.awaitBinder(4000)
        return when {
            ShizukuState.ready() -> ShizukuStatus.READY
            ShizukuState.running() -> if (ShizukuState.preV11()) ShizukuStatus.TOO_OLD else ShizukuStatus.NEEDS_AUTH
            installed -> ShizukuStatus.NOT_RUNNING
            else -> ShizukuStatus.NOT_INSTALLED
        }
    }

    /** Ash can start an activity itself (in front, or exempt), without Shizuku. */
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

    /** The same intent as an `am start` command line (action, data, type, categories, component/package, string extras). */
    @Suppress("DEPRECATION")
    fun amStart(intent: Intent): String {
        val q = PrivShell::quote
        val sb = StringBuilder("am start")
        intent.action?.let { sb.append(" -a ").append(q(it)) }
        intent.data?.let { sb.append(" -d ").append(q(it.toString())) }
        intent.type?.let { sb.append(" -t ").append(q(it)) }
        intent.categories?.forEach { sb.append(" -c ").append(q(it)) }
        val comp = intent.component
        if (comp != null) sb.append(" -n ").append(q(comp.flattenToShortString()))
        else intent.`package`?.let { sb.append(" -p ").append(q(it)) }
        intent.extras?.let { b ->
            for (k in b.keySet()) {
                val v = b.get(k)
                if (v is String) sb.append(" --es ").append(q(k)).append(' ').append(q(v))
                else if (v is Boolean) sb.append(" --ez ").append(q(k)).append(' ').append(v)
                else if (v is Int) sb.append(" --ei ").append(q(k)).append(' ').append(v)
            }
        }
        sb.append(" -f ").append(intent.flags)
        return sb.toString()
    }
}
