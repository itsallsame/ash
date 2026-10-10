package ai.ash.apps

import ai.ash.R

import android.app.Activity
import android.app.AlertDialog
import android.app.Application
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.widget.Toast

/** Where an unanswered 「添加到桌面」 request stands. */
enum class PinVerdict { WAIT, ADDED, NOTHING, GIVE_UP }

/**
 * 「添加到桌面」. Some systems (ColorOS) drop the request until the owner lets the app create home-screen shortcuts,
 * leaving only a system note that is gone at once. So the request is watched — the launcher's accept callback, or the
 * shortcut turning up pinned — and when nothing came of it the owner is told where to allow it: this app's settings
 * page. Once per tap, never retried by itself. A launcher that covers the screen (its own question, or ColorOS's
 * permission note) is waited for; a deliberate no can't be told apart from the permission block, so the note says both.
 */
object Pin {
    /** Nothing by then, with the shell in front all along: the request went nowhere. */
    const val WAIT_MS = 4_000L
    /** After the launcher's own question (or a passing system note) is gone, its answer arrives within this. */
    const val SETTLE_MS = 1_500L
    /** The owner went elsewhere and never came back to the shell: stop watching, say nothing. */
    const val GIVE_UP_MS = 120_000L
    private const val TICK_MS = 250L
    private const val PROBE_MS = 1_000L
    private const val ACTION = "ai.ash.apps.PIN_ACCEPTED"

    private var current: Watch? = null
    private val main by lazy { Handler(Looper.getMainLooper()) }

    /**
     * [asked]: the shell was paused meanwhile (the launcher put its own question in front, or the owner left);
     * [focusedFor]: how long the shell has held the window focus without a break (0 while something covers it).
     */
    fun verdict(elapsed: Long, answered: Boolean, asked: Boolean, focusedFor: Long): PinVerdict = when {
        answered -> PinVerdict.ADDED
        elapsed >= GIVE_UP_MS -> PinVerdict.GIVE_UP
        focusedFor < SETTLE_MS -> PinVerdict.WAIT
        // ColorOS covers the shell with the launcher's page while it shows its permission note, then hands back with
        // nothing added: that looks exactly like a launcher question answered no, so either way the owner is told.
        elapsed >= WAIT_MS -> PinVerdict.NOTHING
        else -> PinVerdict.WAIT
    }

    fun request(a: Activity, id: String, name: String, icon: Bitmap?) {
        current?.stop()
        current = null
        askShell(a, id, name, icon)
    }

    private fun askShell(a: Activity, id: String, name: String, icon: Bitmap?) {
        val sm = a.getSystemService(ShortcutManager::class.java)
        if (sm == null || !runCatching { sm.isRequestPinShortcutSupported }.getOrDefault(false)) { guide(a, name); return }
        val shortcut = "app:$id"
        val info = ShortcutInfo.Builder(a, shortcut)
            .setShortLabel(name.take(24)).setLongLabel(name)
            .setIcon(icon?.let { Icon.createWithBitmap(Ui.square(it)) } ?: Icon.createWithResource(a, R.drawable.ic_launcher))
            .setIntent(Intent(Intent.ACTION_VIEW, Uri.parse(AppIds.link(id))).setClass(a, OpenActivity::class.java))
            .build()
        // Already pinned before asking: its showing up pinned proves nothing, only the callback does.
        val watch = Watch(a, id, name, icon) { runCatching { sm.pinnedShortcuts.any { it.id == shortcut && it.isPinned } }.getOrDefault(false) }
        watch.pinnedBefore = watch.pinned()
        current = watch
        watch.start()  // listening before asking, so a quick answer is not missed
        val sent = runCatching { sm.requestPinShortcut(info, watch.callback.intentSender) }
        // Refused outright (an exception, or false): the owner is told where to allow it.
        if (sent.getOrDefault(false) != true) { watch.stop(); guide(a, name) }
    }

    private class Watch(val a: Activity, val id: String, val name: String, val icon: Bitmap?, val probe: () -> Boolean) {
        val token = SystemClock.elapsedRealtimeNanos().toString()
        val callback: PendingIntent = PendingIntent.getBroadcast(a, "app:$id".hashCode(),
            Intent(ACTION).setPackage(a.packageName).putExtra("token", token), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        /** Until known, a pinned shortcut proves nothing. */
        @Volatile var pinnedBefore = true
        @Volatile private var pinnedNow = false
        @Volatile private var probing = false
        private var lastProbe = 0L
        private val started = SystemClock.uptimeMillis()
        private var focusSince: Long? = null
        @Volatile private var answered = false
        private var asked = false
        private var stopped = false
        private val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) { if (i.getStringExtra("token") == token) answered = true }
        }
        private val lifecycle = object : Application.ActivityLifecycleCallbacks {
            override fun onActivityPaused(x: Activity) { if (x === a) asked = true }
            override fun onActivityCreated(x: Activity, s: Bundle?) {}
            override fun onActivityStarted(x: Activity) {}
            override fun onActivityResumed(x: Activity) {}
            override fun onActivityStopped(x: Activity) {}
            override fun onActivitySaveInstanceState(x: Activity, s: Bundle) {}
            override fun onActivityDestroyed(x: Activity) {}
        }

        fun pinned(): Boolean = probe()

        /** Whether the shortcut shows up pinned, checked off the main thread. */
        private fun probeSoon(now: Long) {
            if (probing || now - lastProbe < PROBE_MS) return
            probing = true; lastProbe = now
            Thread({ pinnedNow = runCatching { probe() }.getOrDefault(false); probing = false }, "apps-pin-probe").start()
        }

        private val tick = object : Runnable {
            override fun run() {
                if (stopped) return
                if (a.isFinishing || a.isDestroyed) { stop(); return }
                val now = SystemClock.uptimeMillis()
                focusSince = if (a.hasWindowFocus()) focusSince ?: now else null
                probeSoon(now)
                if (!pinnedBefore && !answered && pinnedNow) answered = true
                when (verdict(now - started, answered, asked, focusSince?.let { now - it } ?: 0)) {
                    PinVerdict.WAIT -> main.postDelayed(this, TICK_MS)
                    PinVerdict.ADDED -> stop()
                    PinVerdict.GIVE_UP -> stop()
                    PinVerdict.NOTHING -> { stop(); guide(a, name) }
                }
            }
        }

        fun start() {
            val filter = IntentFilter(ACTION)
            if (Build.VERSION.SDK_INT >= 33) a.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            else a.registerReceiver(receiver, filter)
            a.application.registerActivityLifecycleCallbacks(lifecycle)
            main.postDelayed(tick, TICK_MS)
        }

        fun stop() {
            if (stopped) return
            stopped = true
            main.removeCallbacks(tick)
            runCatching { a.unregisterReceiver(receiver) }
            a.application.unregisterActivityLifecycleCallbacks(lifecycle)
            if (current === this) current = null
        }
    }

    /** The owner's way out: what to allow, and a button to this app's settings page. */
    private fun guide(a: Activity, name: String) {
        if (a.isFinishing || a.isDestroyed) return
        AlertDialog.Builder(a)
            .setTitle("没能添加到桌面")
            .setMessage("「$name」的图标没有放到桌面上。如果是你刚才点了取消，忽略这条就好。\n\n" +
                "在 ColorOS（OPPO、一加、realme）等系统上，要先允许「Ash 应用」使用「创建桌面快捷方式」权限：" +
                "点「去设置」，进入「权限」（可能在「其他权限」里），找到「创建桌面快捷方式」，选「允许」，再回来添加一次。")
            .setPositiveButton("去设置") { _, _ -> settings(a, a.packageName, "Ash 应用") }
            .setNegativeButton("知道了", null)
            .show()
    }

    private fun settings(a: Activity, pkg: String, label: String) {
        val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg"))
        for (intent in listOf(details, Intent(Settings.ACTION_SETTINGS))) {
            if (runCatching { a.startActivity(intent) }.isSuccess) return
        }
        Toast.makeText(a, "打不开设置，请在系统设置的应用管理里找到「$label」", Toast.LENGTH_LONG).show()
    }
}
