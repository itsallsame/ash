package ai.ash.kernel.host

import ai.ash.kernel.KernelService
import ai.ash.kernel.Notifications
import ai.ash.kernel.StatusActivity
import ai.ash.kernel.host.adb.AdbClient
import ai.ash.kernel.host.adb.AdbKey
import ai.ash.kernel.host.adb.AdbMdns
import ai.ash.kernel.host.adb.AdbNotPaired
import ai.ash.kernel.host.adb.AdbWrongCode
import android.app.Activity
import android.app.AlertDialog
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import java.util.concurrent.Executors

/** All entrypoints lead to the kernel page. Notifications are optional shortcuts. */
object KernelPairing {
    internal const val NOTICE = "host-shell"
    private val main = Handler(Looper.getMainLooper())
    fun open(a: Activity, done: () -> Unit = {}) {
        a.startActivity(Intent(a, StatusActivity::class.java))
        done()
    }
    fun revoke(a: Activity) {
        AlertDialog.Builder(a).setTitle("撤销配对")
            .setMessage("忘掉配对记录。已启动的宿主会运行到手机重启；也可以在无线调试的已配对设备里删除 Ash。")
            .setPositiveButton("撤销") { _, _ -> KernelHost.revoke(a) }
            .setNegativeButton("取消", null).show()
    }
    internal fun changed(ctx: Context) {
        if (KernelHost.ready()) { cancel(ctx); return }
        if (!AdbKey.paired(ctx)) return
        main.postDelayed({ if (!KernelHost.ready() && AdbKey.paired(ctx)) askToConnect(ctx) }, 20_000)
    }
    internal fun askToConnect(ctx: Context) {
        if (!AdbKey.paired(ctx)) return
        notify(ctx, "宿主要重新接上", "打开 Ash 内核，开启无线调试后点「重新连接」", openPage(ctx), false)
    }
    fun developerOptions(ctx: Context) = Settings.Global.getInt(ctx.contentResolver, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) == 1
    fun wirelessDebugging(ctx: Context) = Settings.Global.getInt(ctx.contentResolver, "adb_wifi_enabled", 0) == 1
    fun onWifi(ctx: Context): Boolean = runCatching {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        cm.allNetworks.any { cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true }
    }.getOrDefault(false)
    internal fun wirelessDebuggingIntent() = Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)
        .putExtra(":settings:fragment_args_key", "toggle_adb_wireless").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    internal fun openPage(ctx: Context): PendingIntent = PendingIntent.getActivity(ctx, 42,
        Intent(ctx, StatusActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    internal fun notification(ctx: Context, title: String, text: String, tap: PendingIntent?, ongoing: Boolean,
        input: Notification.Action? = null, loud: Boolean = true): Notification =
        Notifications.builder(ctx, if (loud) Notifications.CH_URGENT else Notifications.CH_STATUS)
            .setContentTitle(title).setContentText(text).setStyle(Notification.BigTextStyle().bigText(text))
            .setOngoing(ongoing).setAutoCancel(!ongoing).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_REMINDER)
            .apply { if (tap != null) setContentIntent(tap); if (input != null) addAction(input) }.build()
    internal fun notify(ctx: Context, title: String, text: String, tap: PendingIntent?, ongoing: Boolean) =
        ctx.getSystemService(NotificationManager::class.java).notify(NOTICE, 0, notification(ctx, title, text, tap, ongoing))
    internal fun cancel(ctx: Context) = ctx.getSystemService(NotificationManager::class.java).cancel(NOTICE, 0)
    internal fun keyName() = KernelHost.keyName()
    internal fun log(msg: String) = Log.i("ash.hostshell", msg)
}

enum class PairingStage { IDLE, WAITING_CODE, PAIRING, CONNECTING, STARTING, READY, ERROR }
data class PairingProgress(val stage: PairingStage = PairingStage.IDLE, val text: String = "", val pairingPort: Int = 0)

/** One worker owns pairing and launch; page progress does not depend on notification permission. */
class GuideService : Service() {
    private val work = Executors.newSingleThreadExecutor()
    private var mdns: AdbMdns? = null
    private var mode = ""
    private var discoveryEpoch = 0
    private var pairingPort = 0
    private var busy = false
    private var waitingCode: String? = null
    private val main = Handler(Looper.getMainLooper())
    private val expiry = Runnable {
        if (progress.stage != PairingStage.READY) publish(PairingStage.ERROR, "等待超时，请在内核页面重试")
        stopSelf()
    }
    override fun onCreate() { super.onCreate(); running = true; Notifications.createChannel(this) }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        foreground(progress.text.ifEmpty { "正在准备配对" })
        when (intent?.action) {
            PAIR, CONNECT -> work.execute { if (!busy) begin(intent.action!!) }
            CODE -> {
                val code = intent.getStringExtra(KEY_CODE)
                    ?: RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_CODE)?.toString().orEmpty()
                work.execute {
                    if (!busy) {
                        if (!validCode(code)) publish(PairingStage.ERROR, "请输入 6 位数字配对码")
                        else if (pairingPort > 0) pair(pairingPort, code.trim())
                        else {
                            waitingCode = code.trim()
                            begin(PAIR)
                            publish(PairingStage.WAITING_CODE, "正在寻找配对端口，请保持系统配对框打开")
                        }
                    }
                }
            }
            else -> stopSelf()
        }
        main.removeCallbacks(expiry)
        main.postDelayed(expiry, 170_000)
        return START_NOT_STICKY
    }
    private fun begin(next: String) {
        if (KernelHost.ready()) { awaitCore(); return }
        mdns?.stop()
        val epoch = ++discoveryEpoch
        mode = next
        if (next == PAIR) publish(PairingStage.WAITING_CODE, "打开无线调试，查看配对码，在内核页面输入")
        else publish(PairingStage.CONNECTING, "正在连接无线调试")
        mdns = AdbMdns(applicationContext, if (next == PAIR) AdbMdns.PAIRING else AdbMdns.CONNECT) { port ->
            if (!work.isShutdown) runCatching { work.execute {
                if (epoch == discoveryEpoch && mode == next && !busy) {
                    if (next == PAIR) {
                        pairingPort = port
                        publish(PairingStage.WAITING_CODE, "已找到配对端口，输入 6 位配对码")
                        waitingCode?.also { waitingCode = null; pair(port, it) }
                    } else connect(port)
                }
            } }
        }.also { it.start() }
    }
    private fun pair(port: Int, code: String) {
        if (!validCode(code)) { publish(PairingStage.ERROR, "请输入 6 位数字配对码"); return }
        busy = true
        publish(PairingStage.PAIRING, "正在配对")
        try {
            val key = AdbKey.load(this, create = true) ?: error("无法生成配对密钥")
            AdbClient.pair(port, code, key, KernelPairing.keyName())
            AdbKey.markPaired(this)
            pairingPort = 0
            busy = false
            KernelPairing.log("paired")
            begin(CONNECT)
        } catch (_: AdbWrongCode) {
            busy = false
            publish(PairingStage.ERROR, "配对码不对，请重新输入")
        } catch (e: Exception) {
            busy = false
            KernelPairing.log("pairing failed: ${e.javaClass.simpleName}")
            publish(PairingStage.ERROR, "配对失败，请重新打开系统配对框、查看新码后重试")
        }
    }
    private fun connect(port: Int) {
        busy = true
        try {
            publish(PairingStage.CONNECTING, "配对已完成，正在连接无线调试")
            val key = AdbKey.load(this, create = false) ?: throw AdbNotPaired("no key")
            if (!KernelHost.ready()) {
                publish(PairingStage.STARTING, "正在拉起宿主，停止旧中枢")
                AdbClient.shell(port, key, KernelHost.startCommand(this))
            }
            awaitCore()
        } catch (_: AdbNotPaired) {
            busy = false
            AdbKey.forget(this)
            begin(PAIR)
            publish(PairingStage.ERROR, "配对已失效，请查看新的配对码后输入")
        } catch (e: Exception) {
            busy = false
            KernelPairing.log("connect failed: ${e.javaClass.simpleName}: ${e.message}")
            publish(PairingStage.ERROR, "连接失败，请确认无线调试已打开，再点重新连接")
        }
    }
    private fun awaitCore() {
        busy = true
        mdns?.stop()
        discoveryEpoch++
        publish(PairingStage.STARTING, "正在等待宿主和中枢启动")
        val deadline = android.os.SystemClock.elapsedRealtime() + 90_000
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            if (KernelHost.ready() && HostPresence.coreReady) {
                publish(PairingStage.READY, "宿主已连接，中枢已就绪。可以关闭无线调试")
                busy = false
                main.post { stopSelf() }
                return
            }
            if (KernelHost.ready()) publish(PairingStage.STARTING, "宿主已连接 · ${HostPresence.status}")
            Thread.sleep(300)
        }
        busy = false
        publish(PairingStage.ERROR, if (KernelHost.ready()) "宿主已连接，但中枢未就绪：${HostPresence.status}" else "宿主启动失败，请点重新连接")
    }
    private fun publish(stage: PairingStage, text: String) {
        progress = PairingProgress(stage, text, pairingPort)
        main.post { if (running) foreground(text) }
    }
    private fun foreground(text: String) {
        val reply = PendingIntent.getService(this, 43, Intent(this, GuideService::class.java).setAction(CODE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
        val input = if (progress.stage == PairingStage.WAITING_CODE) Notification.Action.Builder(null, "输入配对码", reply)
            .addRemoteInput(RemoteInput.Builder(KEY_CODE).setLabel("6 位配对码").build()).build() else null
        val n = KernelPairing.notification(this, "Ash 内核", text, KernelPairing.openPage(this), true, input, loud = false)
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE)
        else startForeground(ID, n)
    }
    override fun onTimeout(startId: Int) { publish(PairingStage.ERROR, "等待超时，请在内核页面重试"); stopSelf() }
    override fun onDestroy() {
        running = false
        main.removeCallbacksAndMessages(null)
        mdns?.stop()
        work.shutdownNow()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
    companion object {
        const val PAIR = "ai.ash.hostshell.PAIR"
        const val CONNECT = "ai.ash.hostshell.CONNECT"
        private const val CODE = "ai.ash.hostshell.CODE"
        private const val KEY_CODE = "code"
        private const val ID = 0x5a17
        @Volatile var progress = PairingProgress()
            private set
        @Volatile var running = false
            private set
        internal fun validCode(code: String) = code.trim().matches(Regex("[0-9]{6}"))
        fun start(ctx: Context, action: String) {
            KernelService.start(ctx)
            ctx.startForegroundService(Intent(ctx, GuideService::class.java).setAction(action))
        }
        fun submit(ctx: Context, code: String) = ctx.startForegroundService(
            Intent(ctx, GuideService::class.java).setAction(CODE).putExtra(KEY_CODE, code))
    }
}

/** Existing app links land on the same persistent kernel page. */
class GuideActivity : StatusActivity()
