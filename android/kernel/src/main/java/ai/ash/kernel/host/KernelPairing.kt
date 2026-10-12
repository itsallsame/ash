package ai.ash.kernel.host

import ai.ash.kernel.host.adb.AdbClient
import ai.ash.kernel.host.adb.AdbKey
import ai.ash.kernel.host.adb.AdbMdns
import ai.ash.kernel.host.adb.AdbNotPaired
import ai.ash.kernel.host.adb.AdbWrongCode
import ai.ash.kernel.Notifications
import android.app.Activity
import android.app.AlertDialog
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.database.ContentObserver
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import java.util.concurrent.Executors

/**
 * How Ash leads the owner to give it the phone's debug identity, and to start it again after a restart. Ash only reads and
 * asks: the owner opens wireless debugging, pairs, and turns it off again; Ash reads the announcement of the port, talks to
 * it with its own key, and starts the service with one fixed command (the line [KernelHost.startCommand]). It never writes a
 * setting, grants itself nothing and turns nothing on or off.
 */
object KernelPairing {
    private const val TAG = "ash.hostshell"
    internal const val NOTICE = "host-shell"

    /** 「去开启」/「去配对」: pair when Ash has no key yet, otherwise connect again. [done] runs once nothing is left on [a]. */
    fun open(a: Activity, done: () -> Unit = {}) {
        if (KernelHost.ready()) return done()
        val pairing = !AdbKey.exists(a)
        if (!developerOptions(a)) {
            AlertDialog.Builder(a).setTitle("先打开开发者选项")
                .setMessage("在「关于手机」里连点「版本号」7 次，打开开发者选项，再回 Ash 点一次「去开启」。")
                .setPositiveButton("去关于手机") { _, _ -> runCatching { a.startActivity(Intent(Settings.ACTION_DEVICE_INFO_SETTINGS)) } }
                .setNegativeButton("以后再说", null).setOnDismissListener { done() }.show()
            return
        }
        if (!onWifi(a)) {
            Toast.makeText(a, "无线调试要连着 Wi-Fi 才能打开：先连上 Wi-Fi", Toast.LENGTH_LONG).show()
            return done()
        }
        GuideService.start(a, if (pairing) GuideService.PAIR else GuideService.CONNECT)
        Toast.makeText(a, if (pairing) "打开「无线调试」，点「使用配对码配对设备」，再下拉通知栏输入配对码" else "打开「无线调试」开关，Ash 会自己接上", Toast.LENGTH_LONG).show()
        openWirelessDebugging(a)
        done()
    }

    /** 「撤销」: stops the service and forgets Ash's key; the owner removes Ash from the paired devices themself. */
    fun revoke(a: Activity) {
        AlertDialog.Builder(a).setTitle("撤销「后台也能动手」")
            .setMessage("Ash 会停掉它在手机上的后台服务，并忘掉配对。之后可以在「开发者选项 › 无线调试 › 已配对的设备」里把 Ash 也删掉。")
            .setPositiveButton("撤销") { _, _ -> KernelHost.revoke(a) }
            .setNegativeButton("取消", null).show()
    }

    /** The part came or went: say so to the owner when it went without being asked to (the phone restarted, or the system stopped it). */
    internal fun changed(ctx: Context) {
        if (KernelHost.ready()) { cancel(ctx); return }
        if (!AdbKey.exists(ctx)) return
        // An update of Ash starts the new service a moment later: only a part still gone after that is news.
        main.postDelayed({ if (!KernelHost.ready() && AdbKey.exists(ctx)) askToConnect(ctx) }, 20_000)
    }

    /** After a restart the service is gone; the owner is asked to connect it again (one notice, three taps). */
    internal fun askToConnect(ctx: Context) {
        notify(ctx, "后台动手要重新接上", "手机重启过或服务停了：点这里，打开「无线调试」开关，接好后再关掉",
            PendingIntent.getActivity(ctx, 41, Intent(ctx, GuideActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE), ongoing = false)
    }

    // ---- reading the phone (nothing is changed) ----

    fun developerOptions(ctx: Context): Boolean = Settings.Global.getInt(ctx.contentResolver, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 1

    fun wirelessDebugging(ctx: Context): Boolean = Settings.Global.getInt(ctx.contentResolver, "adb_wifi_enabled", 0) == 1

    fun onWifi(ctx: Context): Boolean = runCatching {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        cm.allNetworks.any { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true }
    }.getOrDefault(false)

    /** The developer options, scrolled to wireless debugging. */
    internal fun wirelessDebuggingIntent(): Intent = Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
        .putExtra(":settings:fragment_args_key", "toggle_adb_wireless").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    private fun openWirelessDebugging(ctx: Context) {
        runCatching { ctx.startActivity(wirelessDebuggingIntent()) }
            .onFailure { runCatching { ctx.startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
    }

    // ---- notices ----

    private val main = Handler(Looper.getMainLooper())

    /** [loud]: the owner has something to do now (a code to type, a switch to turn off); progress is shown silently. */
    internal fun notification(ctx: Context, title: String, text: String, tap: PendingIntent?, ongoing: Boolean, input: Notification.Action? = null, loud: Boolean = true): Notification =
        Notifications.builder(ctx, if (loud) Notifications.CH_URGENT else Notifications.CH_STATUS).setContentTitle(title).setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text)).setOngoing(ongoing).setAutoCancel(!ongoing).setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_REMINDER)
            .apply { if (tap != null) setContentIntent(tap); if (input != null) addAction(input) }
            .build()

    internal fun notify(ctx: Context, title: String, text: String, tap: PendingIntent?, ongoing: Boolean, input: Notification.Action? = null) =
        ctx.getSystemService(NotificationManager::class.java).notify(NOTICE, 0, notification(ctx, title, text, tap, ongoing, input))

    internal fun cancel(ctx: Context) = ctx.getSystemService(NotificationManager::class.java).cancel(NOTICE, 0)

    internal fun openPage(ctx: Context): PendingIntent =
        PendingIntent.getActivity(ctx, 42, wirelessDebuggingIntent(), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    /** How Ash's key names it in the phone's list of paired devices. */
    internal fun keyName(): String = "ash@" + (Build.MODEL ?: "phone").replace(Regex("[^A-Za-z0-9._-]"), "_")

    internal fun log(msg: String) = Log.i(TAG, msg)
}

/**
 * The few minutes of a pairing or a reconnection, while the owner is in the system's settings: Ash waits for the port to be
 * announced, takes the code from its notification, and starts the service. A short foreground service, so that the system
 * lets it finish while Ash is in the background.
 */
class GuideService : Service() {
    private val work = Executors.newSingleThreadExecutor()
    private var mdns: AdbMdns? = null
    private var mode = ""
    private var pairingPort = 0
    private var busy = false
    private var watcher: ContentObserver? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val ctx = applicationContext
        when (intent?.action) {
            PAIR, CONNECT -> {
                foreground(if (intent.action == PAIR) waiting(PAIR) else waiting(CONNECT))
                begin(intent.action!!)
            }
            CODE -> {
                foreground(KernelPairing.notification(ctx, "正在配对…", "请稍等", null, ongoing = true, loud = false))
                val code = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_CODE)?.toString()?.trim().orEmpty()
                val port = intent.getIntExtra(EXTRA_PORT, pairingPort)
                work.execute { pair(port, code) }
            }
            else -> stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun begin(next: String) {
        mdns?.stop()
        mode = next
        val type = if (next == PAIR) AdbMdns.PAIRING else AdbMdns.CONNECT
        mdns = AdbMdns(applicationContext, type) { port -> work.execute { found(next, port) } }.also { it.start() }
    }

    private fun found(kind: String, port: Int) {
        if (kind != mode || busy) return
        when (kind) {
            PAIR -> {
                pairingPort = port
                foreground(askCode(port, "在手机屏幕上看到的 6 位配对码，输在这里"))
            }
            CONNECT -> connect(port)
        }
    }

    private fun pair(port: Int, code: String) {
        if (code.length !in 6..8 || port <= 0) { foreground(askCode(port, "配对码是 6 位数字，再输一次")); return }
        busy = true
        try {
            val key = AdbKey.load(applicationContext, create = true) ?: throw IllegalStateException("no key")
            AdbClient.pair(port, code, key, KernelPairing.keyName())
            KernelPairing.log("paired")
            foreground(KernelPairing.notification(applicationContext, "配对好了，正在接上…", "请稍等，不要关掉无线调试", null, ongoing = true, loud = false))
            busy = false
            begin(CONNECT)
        } catch (e: AdbWrongCode) {
            busy = false
            foreground(askCode(port, "配对码不对，再看一眼屏幕上的码"))
        } catch (e: Exception) {
            busy = false
            KernelPairing.log("pairing failed: ${e.javaClass.simpleName}")
            foreground(askCode(port, "没配对上（${e.javaClass.simpleName}）。确认配对框还开着，再输一次"))
        }
    }

    private fun connect(port: Int) {
        busy = true
        val ctx = applicationContext
        try {
            val key = AdbKey.load(ctx, create = false) ?: throw AdbNotPaired("no key")
            AdbClient.shell(port, key, KernelHost.startCommand(ctx))
            val end = System.currentTimeMillis() + 10_000
            while (!KernelHost.ready() && System.currentTimeMillis() < end) Thread.sleep(200)
            if (!KernelHost.ready()) throw IllegalStateException("the service did not come up")
            KernelPairing.log("the service is up")
            mdns?.stop()
            done()
        } catch (e: AdbNotPaired) {
            busy = false
            KernelPairing.log("not paired any more: ${e.message}")
            foreground(KernelPairing.notification(ctx, "配对失效了，要重新配对", "超过 7 天没接上过，或配对被删了：在无线调试里点「使用配对码配对设备」",
                KernelPairing.openPage(ctx), ongoing = true))
            AdbKey.forget(ctx)
            begin(PAIR)
        } catch (e: Exception) {
            busy = false
            KernelPairing.log("connect failed: ${e.javaClass.simpleName}: ${e.message}")
            foreground(KernelPairing.notification(ctx, "没接上，再试一次", "把「无线调试」关掉再打开，Ash 会再接一次", KernelPairing.openPage(ctx), ongoing = true))
        }
    }

    /** Connected: ask the owner to turn wireless debugging off, and stop once they have. */
    private fun done() {
        val ctx = applicationContext
        if (!KernelPairing.wirelessDebugging(ctx)) return finish()
        foreground(KernelPairing.notification(ctx, "已接上。可以关掉无线调试了", "点这里打开无线调试，把开关关掉（后台动手会一直在，直到手机重启）",
            KernelPairing.openPage(ctx), ongoing = true))
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { if (!KernelPairing.wirelessDebugging(ctx)) finish() }
        }
        watcher = observer
        contentResolver.registerContentObserver(Settings.Global.getUriFor("adb_wifi_enabled"), false, observer)
    }

    private fun finish() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        KernelPairing.cancel(applicationContext)
        stopSelf()
    }

    override fun onTimeout(startId: Int) {
        // A short service has about three minutes; a guide still waiting then is left to the owner's next 「去开启」.
        val ctx = applicationContext
        stopForeground(STOP_FOREGROUND_REMOVE)
        if (!KernelHost.ready()) KernelPairing.notify(ctx, "没等到无线调试", "下次在 Ash 的体检里点「后台也能动手 › 去开启」再来", null, ongoing = false)
        stopSelf()
    }

    override fun onDestroy() {
        mdns?.stop()
        watcher?.let { contentResolver.unregisterContentObserver(it) }
        work.shutdownNow()
        super.onDestroy()
    }

    private fun waiting(kind: String): Notification = KernelPairing.notification(applicationContext,
        if (kind == PAIR) "等你点「使用配对码配对设备」" else "等你打开「无线调试」",
        if (kind == PAIR) "开发者选项 › 无线调试：打开开关，点「使用配对码配对设备」，然后回这里输入配对码" else "开发者选项 › 无线调试：打开开关，Ash 会自己接上",
        KernelPairing.openPage(applicationContext), ongoing = true, loud = false)

    private fun askCode(port: Int, text: String): Notification {
        val reply = PendingIntent.getService(this, 43, Intent(this, GuideService::class.java).setAction(CODE).putExtra(EXTRA_PORT, port),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
        val action = Notification.Action.Builder(null, "输入配对码", reply)
            .addRemoteInput(RemoteInput.Builder(KEY_CODE).setLabel("6 位配对码").build()).build()
        return KernelPairing.notification(applicationContext, "输入配对码", text, null, ongoing = true, input = action)
    }

    private fun foreground(n: Notification) {
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE)
        else startForeground(ID, n)
    }

    companion object {
        const val PAIR = "ai.ash.hostshell.PAIR"
        const val CONNECT = "ai.ash.hostshell.CONNECT"
        private const val CODE = "ai.ash.hostshell.CODE"
        private const val EXTRA_PORT = "port"
        private const val KEY_CODE = "code"
        private const val ID = 0x5a17

        fun intent(ctx: Context, action: String): Intent = Intent(ctx, GuideService::class.java).setAction(action)

        fun start(ctx: Context, action: String) { ctx.startForegroundService(intent(ctx, action)) }
    }
}

/** The notice's tap: an activity (a notification may not start one through a service), which begins the guide and goes. */
class GuideActivity : Activity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        KernelPairing.open(this) { finish() }
    }
}
