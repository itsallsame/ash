package ai.ash.kernel

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import java.util.concurrent.Executors

/**
 * The resident part of the kernel package: a foreground service that is the Android kernel host of `ash-host/1`.
 *   - runs [KernelSupervisor] (install, start the core, restart it with backoff, heartbeat),
 *   - serves the host interface ([KernelHostServer]),
 *   - keeps the hand app bound and hands it the local link ([HandConnector]),
 *   - tells the core what changes around it: alarms, network, power saver, shutdown (host events on its standard input).
 */
class KernelService : Service() {
    private lateinit var secrets: Secrets
    private lateinit var log: RotatingLog
    private lateinit var supervisor: KernelSupervisor
    private lateinit var server: KernelHostServer
    private lateinit var connector: HandConnector
    private lateinit var wake: WakeManager
    private lateinit var sys: SystemEnv
    private val scheduler = ExecutorScheduler()
    private val events = Executors.newSingleThreadExecutor { r -> Thread(r, "ash-events").apply { isDaemon = true } }
    private val receivers = ArrayList<BroadcastReceiver>()
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var lastShown: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Notifications.createChannel(this)
        startForeground(Notifications.ID, Notifications.build(this, KernelText.STARTING))
        val paths = Paths(this)
        log = RotatingLog(paths.logs)
        secrets = Secrets(this)
        sys = SystemEnv(this)
        val version = packageManager.getPackageInfo(packageName, 0).versionName ?: "0"

        wake = WakeManager(AndroidAlarms(this))
        val link = AndroidHandLink(this)
        connector = HandConnector(link, scheduler, version, log = { Log.i(TAG, it) })
        link.connector = connector

        val callbacks = object : HostCallbacks {
            override fun onActivity() = supervisor.onActivity()
            override fun onReady(version: String, linkPort: Int) = supervisor.onReady(version, linkPort)
            override fun onRestart(reason: String) = supervisor.onRestart(reason)
            override fun onStatus(text: String, state: String) = supervisor.onStatus(text, state)
        }
        val api = HostApi(HostApi.CAPABILITIES, Keys, wake, AndroidPower.get(this), connector, callbacks) { Log.w(TAG, it) }
        server = KernelHostServer(api) { Log.w(TAG, it) }
        server.start()

        supervisor = KernelSupervisor(
            clock = SystemClock(),
            provisioner = AndroidProvisioner(this, paths),
            launcher = AndroidNodeLauncher(this, paths, sys, api, server, log, version),
            env = sys,
            stopped = { secrets.stopped },
            show = ::show,
            note = { Log.i(TAG, it); log.note(it) },
            onNodeGone = { api.token = null; connector.forget() },
            powerSaver = { getSystemService(PowerManager::class.java).isPowerSaveMode },
        )

        // Stale core from an earlier host process first, then supervise.
        Thread({
            NodeProcess.reapStale(paths.nodePid, paths.coreBundle) { log.note(it) }
            connector.start()
            supervisor.run()
        }, "ash-supervisor").start()
        watchEnvironment()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Any start request is a chance to bind a hand app that was installed after the kernel started (no-op when bound).
        connector.start()
        when (intent?.action) {
            ACTION_STOP -> { secrets.stopped = true; supervisor.poke() }
            ACTION_START -> { secrets.stopped = false; supervisor.poke() }
            ACTION_RESTART -> {
                secrets.stopped = false
                supervisor.requestRestart("restart action")
            }
            ACTION_WAKE -> {
                val at = intent.getLongExtra(EXTRA_AT, 0L).takeIf { it > 0 } ?: System.currentTimeMillis()
                wake.fired(at)
                events.execute { supervisor.sendEvent(HostEvents.wakeFired(at)) }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        unwatchEnvironment()
        connector.stop()
        scheduler.shutdown()
        server.stop()
        // The core gets its lifecycle.stop and a few seconds; this must not hold up the main thread.
        Thread({ supervisor.shutdown("service_destroyed", 5_000) }, "ash-shutdown").start()
        super.onDestroy()
    }

    private fun show(text: String) {
        if (text == lastShown) return
        lastShown = text
        status = text
        Notifications.update(this, text)
    }

    private fun watchEnvironment() {
        val cm = getSystemService(ConnectivityManager::class.java)
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = supervisor.poke()
            override fun onLost(network: Network) = supervisor.poke()
            override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) = supervisor.poke()
        }
        try { cm.registerDefaultNetworkCallback(cb); networkCallback = cb } catch (e: Exception) { Log.w(TAG, "network callback: ${e.javaClass.simpleName}") }

        val power = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val saver = getSystemService(PowerManager::class.java).isPowerSaveMode
                events.execute { supervisor.sendEvent(HostEvents.powerChanged(saver)) }
            }
        }
        val shutdown = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val pending = goAsync()
                Thread({
                    try { supervisor.shutdown("system_shutdown", 5_000) } finally { pending.finish() }
                }, "ash-shutdown").start()
            }
        }
        registerReceiver(power, IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED))
        registerReceiver(shutdown, IntentFilter(Intent.ACTION_SHUTDOWN))
        receivers += power; receivers += shutdown
    }

    private fun unwatchEnvironment() {
        networkCallback?.let { runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } }
        for (r in receivers) runCatching { unregisterReceiver(r) }
        receivers.clear()
    }

    companion object {
        private const val TAG = "ash.kernel"
        const val ACTION_START = "ai.ash.kernel.START"
        const val ACTION_STOP = "ai.ash.kernel.STOP"
        const val ACTION_RESTART = "ai.ash.kernel.RESTART"
        const val ACTION_WAKE = "ai.ash.kernel.WAKE"
        const val EXTRA_AT = "at"

        /** The line the notification shows now (null before the service ran in this process); [StatusActivity] shows it too. */
        @Volatile var status: String? = null
            private set

        fun start(ctx: Context, action: String? = null, at: Long = 0L) {
            val i = Intent(ctx, KernelService::class.java).setAction(action)
            if (at > 0) i.putExtra(EXTRA_AT, at)
            ctx.startForegroundService(i)
        }
    }
}
