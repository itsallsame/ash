package ai.ash.kernel.host

import ai.ash.kernel.KernelService
import ai.ash.kernel.KernelText
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
    fun pairingNotificationsEnabled(ctx: Context): Boolean {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        return nm.areNotificationsEnabled() && nm.getNotificationChannel(Notifications.CH_PAIRING)?.importance != NotificationManager.IMPORTANCE_NONE
    }
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
    /**
     * The host layer died while the kernel stayed (adbd restarted: a cable plugged or pulled, the USB use changed). Strong: banner,
     * sound, vibration; a tap opens the guide that connects it again. Taken down by [cancel] when it is back. Nothing is switched
     * or connected here: that stays the owner's.
     */
    fun hostLost(ctx: Context) {
        if (!AdbKey.paired(ctx)) return
        val n = Notifications.builder(ctx, Notifications.CH_HOST_LOST)
            .setContentTitle(KernelText.HOST_LOST_TITLE).setContentText(KernelText.HOST_LOST_TEXT)
            .setStyle(Notification.BigTextStyle().bigText(KernelText.HOST_LOST_TEXT))
            .setContentIntent(openPage(ctx)).setAutoCancel(true).setCategory(Notification.CATEGORY_ALARM)
            .setVisibility(Notification.VISIBILITY_PUBLIC).build()
        // Same tag as the reconnect prompt: take that one down first so this is a new notification, not an update that may stay quiet.
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.cancel(NOTICE, 0)
        nm.notify(NOTICE, 0, n)
    }
    internal fun cancel(ctx: Context) = ctx.getSystemService(NotificationManager::class.java).cancel(NOTICE, 0)
    internal fun keyName() = KernelHost.keyName()
    internal fun log(msg: String) = Log.i("ash.hostshell", msg)
}

enum class PairingStage { IDLE, WAITING_CODE, PAIRING, CONNECTING, STARTING, READY, ERROR }
data class PairingProgress(val stage: PairingStage = PairingStage.IDLE, val text: String = "", val pairingPort: Int = 0,
    val pairing: Boolean = false) {
    val acceptsCode: Boolean get() = pairing && stage in listOf(PairingStage.IDLE, PairingStage.WAITING_CODE, PairingStage.ERROR)
}

/** One worker owns pairing and launch. The input notification is posted first, before any port discovery. */
class GuideService : Service() {
    private val work = Executors.newSingleThreadExecutor()
    private var mdns: AdbMdns? = null
    private var mode = ""
    private var discoveryEpoch = 0
    private var pairingPort = 0
    private var busy = false
    private var waitingCode: String? = null
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var pendingMode = ""
    @Volatile private var closed = false
    @Volatile private var generation = 0
    @Synchronized private fun newRequest(): Int = ++generation
    @Synchronized private fun remember(next: String, request: Int = generation) {
        if (request != generation || (closed && next.isNotEmpty())) return
        pendingMode = next
        getSharedPreferences("ash.pairing", MODE_PRIVATE).edit().putString("mode", next).apply()
    }
    override fun onCreate() {
        super.onCreate()
        running = true
        Notifications.createChannel(this)
        pendingMode = getSharedPreferences("ash.pairing", MODE_PRIVATE).getString("mode", "").orEmpty()
        if (pendingMode == PAIR) progress = PairingProgress(PairingStage.WAITING_CODE, "输入配对码", pairing = true)
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: pendingMode
        when (action) {
            PAIR -> {
                val request = newRequest()
                remember(PAIR)
                // Highest priority: an actual input action, immediately, including before discovery has a port.
                progress = PairingProgress(PairingStage.WAITING_CODE, "打开系统配对框，把 6 位码输在这条通知里", pairing = true)
                foreground(progress.text)
                work.execute { begin(PAIR, request) }
            }
            CONNECT -> {
                val request = newRequest()
                remember(CONNECT)
                foreground("正在连接宿主")
                work.execute { begin(CONNECT, request) }
            }
            CODE -> {
                if (progress.stage == PairingStage.PAIRING) return START_STICKY
                val request = newRequest()
                foreground(progress.text.ifEmpty { "输入配对码" })
                val code = intent?.getStringExtra(KEY_CODE)
                    ?: intent?.let { RemoteInput.getResultsFromIntent(it) }?.getCharSequence(KEY_CODE)?.toString().orEmpty()
                val replyPort = intent?.getIntExtra(EXTRA_PORT, 0) ?: 0
                remember(PAIR)
                work.execute {
                    if (!busy) {
                        if (!validCode(code)) {
                            begin(PAIR, request)
                            publish(PairingStage.ERROR, "请输入 6 位数字配对码", request)
                        }
                        else if (replyPort in 1..65535) pair(replyPort, code.trim(), request)
                        else if (pairingPort > 0) pair(pairingPort, code.trim(), request)
                        else {
                            waitingCode = code.trim()
                            begin(PAIR, request)
                            publish(PairingStage.WAITING_CODE, "正在寻找配对端口，请保持系统配对框打开", request)
                        }
                    }
                }
            }
            CANCEL -> {
                newRequest()
                closed = true
                foreground("配对已取消")
                remember("")
                progress = PairingProgress()
                stopSelf()
            }
            else -> { stopSelf(); return START_NOT_STICKY }
        }
        return START_STICKY
    }
    private fun begin(next: String, request: Int) {
        if (closed || request != generation) return
        if (next == CONNECT && KernelHost.ready()) { awaitCore(request); return }
        mdns?.stop()
        val epoch = ++discoveryEpoch
        mode = next
        if (next == PAIR) publish(PairingStage.WAITING_CODE, "打开系统配对框后，下拉通知点「输入配对码」。系统分屏时也可以在本页输入", request)
        else publish(PairingStage.CONNECTING, "正在连接无线调试", request)
        mdns = AdbMdns(applicationContext, if (next == PAIR) AdbMdns.PAIRING else AdbMdns.CONNECT) { port ->
            if (!work.isShutdown) runCatching { work.execute {
                if (request == generation && epoch == discoveryEpoch && mode == next && !busy) {
                    if (next == PAIR) {
                        pairingPort = port
                        KernelPairing.log("found pairing port $port")
                        publish(PairingStage.WAITING_CODE, "已找到配对端口，输入 6 位配对码", request)
                        waitingCode?.also { waitingCode = null; pair(port, it, request) }
                    } else { KernelPairing.log("found connect port $port"); connect(port, request) }
                }
            } }
        }.also { it.start() }
    }
    private fun pair(port: Int, code: String, request: Int) {
        if (closed || request != generation) return
        if (!validCode(code)) { publish(PairingStage.ERROR, "请输入 6 位数字配对码", request); return }
        busy = true
        mode = PAIR
        pairingPort = port
        publish(PairingStage.PAIRING, "正在配对", request)
        try {
            val key = AdbKey.load(this, create = true) ?: error("无法生成配对密钥")
            AdbClient.pair(port, code, key, KernelPairing.keyName())
            if (closed || request != generation) { busy = false; return }
            AdbKey.markPaired(this)
            remember(CONNECT, request)
            pairingPort = 0
            busy = false
            KernelPairing.log("paired")
            begin(CONNECT, request)
        } catch (_: AdbWrongCode) {
            busy = false
            publish(PairingStage.ERROR, "配对码不对，请重新输入", request)
        } catch (e: Exception) {
            busy = false
            KernelPairing.log("pairing failed: ${e.javaClass.simpleName}")
            publish(PairingStage.ERROR, "配对失败，请重新打开系统配对框、查看新码后重试", request)
        }
    }
    private fun connect(port: Int, request: Int) {
        if (closed || request != generation) return
        busy = true
        try {
            publish(PairingStage.CONNECTING, "配对已完成，正在连接无线调试", request)
            val key = AdbKey.load(this, create = false) ?: throw AdbNotPaired("no key")
            if (!KernelHost.ready()) {
                publish(PairingStage.STARTING, "正在拉起宿主，停止旧中枢", request)
                AdbClient.shell(port, key, KernelHost.startCommand(this))
            }
            awaitCore(request)
        } catch (_: AdbNotPaired) {
            busy = false
            if (request != generation || closed) return
            AdbKey.forget(this)
            remember(PAIR, request)
            begin(PAIR, request)
            publish(PairingStage.ERROR, "配对已失效，请查看新的配对码后输入", request)
        } catch (e: Exception) {
            busy = false
            KernelPairing.log("connect failed: ${e.javaClass.simpleName}: ${e.message}")
            publish(PairingStage.ERROR, "连接失败，请确认无线调试已打开，再点重新连接", request)
        }
    }
    private fun awaitCore(request: Int) {
        busy = true
        mdns?.stop()
        discoveryEpoch++
        publish(PairingStage.STARTING, "正在等待宿主和中枢启动", request)
        val deadline = android.os.SystemClock.elapsedRealtime() + 90_000
        while (!closed && request == generation && android.os.SystemClock.elapsedRealtime() < deadline) {
            if (KernelHost.ready() && HostPresence.coreReady) {
                publish(PairingStage.READY, "宿主已连接，中枢已就绪。可以关闭无线调试", request)
                busy = false
                main.post { finishReady(request) }
                return
            }
            if (KernelHost.ready()) publish(PairingStage.STARTING, "宿主已连接 · ${HostPresence.status}", request)
            Thread.sleep(300)
        }
        busy = false
        publish(PairingStage.ERROR, if (KernelHost.ready()) "宿主已连接，但中枢未就绪：${HostPresence.status}" else "宿主启动失败，请点重新连接", request)
    }
    private fun finishReady(request: Int) {
        if (closed || request != generation) return
        remember("", request)
        // Replace the reply/spinner with a final result before ending the foreground service.
        stopForeground(STOP_FOREGROUND_REMOVE)
        val n = Notifications.builder(this, Notifications.CH_PAIRING)
            .setContentTitle("配对成功，宿主已连接")
            .setContentText("中枢已就绪。无线调试可以关闭了")
            .setContentIntent(KernelPairing.openPage(this)).setAutoCancel(true).setOnlyAlertOnce(true)
            .setTimeoutAfter(5_000).build()
        getSystemService(NotificationManager::class.java).notify(ID, n)
        stopSelf()
    }
    @Synchronized private fun publish(stage: PairingStage, text: String, request: Int) {
        if (closed || request != generation) return
        progress = PairingProgress(stage, text, pairingPort, pendingMode == PAIR)
        main.post { if (running && request == generation) foreground(text) }
    }
    private fun foreground(text: String) {
        // Carry the discovered port in the reply, so input still works after this service was recreated.
        val reply = PendingIntent.getForegroundService(this, 43,
            Intent(this, GuideService::class.java).setAction(CODE).putExtra(EXTRA_PORT, progress.pairingPort),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
        val wantsInput = progress.acceptsCode
        val input = if (wantsInput) Notification.Action.Builder(null, "输入配对码", reply)
            .addRemoteInput(RemoteInput.Builder(KEY_CODE).setLabel("6 位配对码").build()).build() else null
        val pairing = pendingMode == PAIR || input != null
        val n = Notifications.builder(this, if (pairing) Notifications.CH_PAIRING else Notifications.CH_STATUS)
            .setContentTitle(if (input != null) "输入配对码" else "Ash 内核")
            .setContentText(text).setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(KernelPairing.openPage(this)).setOngoing(true).setOnlyAlertOnce(true)
            // Keep this card out of the resident/reconnect notification's automatic collapsed app group.
            .apply { if (pairing) setGroup("ash.pairing.input") }
            .apply {
                if (input != null) addAction(input)
                if (pairing) addAction(Notification.Action.Builder(null, "取消配对",
                    PendingIntent.getForegroundService(this@GuideService, 44,
                        Intent(this@GuideService, GuideService::class.java).setAction(CANCEL),
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build())
            }.build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(ID, n)
    }
    override fun onTimeout(startId: Int) { stopSelf() }
    override fun onDestroy() {
        closed = true
        running = false
        main.removeCallbacksAndMessages(null)
        mdns?.stop()
        work.shutdownNow()
        // Keep the existing actionable notice across a service restart; the reply carries its port and restarts us.
        stopForeground(if (pendingMode == PAIR) STOP_FOREGROUND_DETACH else STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
    companion object {
        const val PAIR = "ai.ash.hostshell.PAIR"
        const val CONNECT = "ai.ash.hostshell.CONNECT"
        private const val CODE = "ai.ash.hostshell.CODE"
        private const val CANCEL = "ai.ash.hostshell.CANCEL"
        private const val KEY_CODE = "code"
        private const val EXTRA_PORT = "port"
        private const val ID = 0x5a17
        @Volatile var progress = PairingProgress()
            private set
        @Volatile var running = false
            private set
        internal fun validCode(code: String) = code.trim().matches(Regex("[0-9]{6}"))
        fun start(ctx: Context, action: String) {
            ctx.startForegroundService(Intent(ctx, GuideService::class.java).setAction(action))
            KernelService.start(ctx)
        }
        fun submit(ctx: Context, code: String) = ctx.startForegroundService(
            Intent(ctx, GuideService::class.java).setAction(CODE).putExtra(KEY_CODE, code))
    }
}

/** Existing app links land on the same persistent kernel page. */
class GuideActivity : StatusActivity()
