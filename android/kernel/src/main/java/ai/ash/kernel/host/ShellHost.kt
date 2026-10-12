package ai.ash.kernel.host

import ai.ash.kernel.AlarmPort
import ai.ash.kernel.Clock
import ai.ash.kernel.Codec
import ai.ash.kernel.HostApi
import ai.ash.kernel.HostCallbacks
import ai.ash.kernel.HostEvents
import ai.ash.kernel.Identity
import ai.ash.kernel.KernelHostServer
import ai.ash.kernel.KernelSupervisor
import ai.ash.kernel.Paths
import ai.ash.kernel.PowerPort
import ai.ash.kernel.Provisioner
import ai.ash.kernel.SystemClock
import ai.ash.kernel.SystemEnv
import ai.ash.kernel.WakeManager
import android.os.Looper
import android.os.Process
import android.util.Log
import java.io.File

/**
 * The kernel's host layer, run as the shell user (uid 2000) by `app_process` from the kernel APK, started through
 * wireless debugging. It supervises the core (install, start it with [ShellNodeLauncher] through run-as, restart it with
 * backoff, heartbeat) and serves the core's host interface. What its identity cannot do — the Keystore, the alarm clock,
 * writing the package storage — it asks the kernel package through [IKernelBridge]. Because the core's parent is this
 * process (outside the package's cgroup, at adbd's oom_score_adj -1000), the maker's background cleaning does not kill it.
 *
 * Started as `app_process /system/bin --nice-name=ash_kernel_host ai.ash.kernel.host.ShellHost <package> <uid>`.
 */
object ShellHost {
    private const val TAG = "ash.kernel.host"

    @JvmStatic
    fun main(args: Array<String>) {
        Looper.prepareMainLooper()
        try {
            require(Process.myUid() == Process.SHELL_UID) { "must run as the shell user, not uid ${Process.myUid()}" }
            require(args.size == 2) { "usage: ShellHost <package> <uid>" }
            run(args[0], args[1].toInt())
        } catch (t: Throwable) {
            Log.e(TAG, "cannot start", t)
            System.exit(1)
        }
        Looper.loop()
    }

    private fun run(pkg: String, kernelUid: Int) {
        val ctx = FakeContext.get()
        val userId = kernelUid / 100_000
        val bundle = ProviderClient.call("$pkg.kernelhost", userId, "bridge", null)
            ?: throw IllegalStateException("the kernel bridge is not there (is $pkg installed?)")
        val bridge = IKernelBridge.Stub.asInterface(bundle.getBinder("bridge"))
            ?: throw IllegalStateException("the kernel bridge is not usable")

        val dataDir = ctx.packageManager.getApplicationInfo(pkg, 0).dataDir
        val paths = Paths(File(dataDir, "files"), File(dataDir, "cache"))
        val runDir = File("/data/local/tmp/ash-kernel-host").apply { mkdirs() }
        val sys = SystemEnv(ctx)

        bridge.provision() // install payload and container (idempotent) before the first start

        val clock: Clock = SystemClock()
        lateinit var supervisor: KernelSupervisor
        val callbacks = object : HostCallbacks {
            override fun onActivity() = supervisor.onActivity()
            override fun onReady(version: String, linkPort: Int) = supervisor.onReady(version, linkPort)
            override fun onRestart(reason: String) = supervisor.onRestart(reason)
            override fun onStatus(text: String, state: String) = supervisor.onStatus(text, state)
        }
        val power = BridgePower(bridge)
        val api = HostApi(HostApi.CAPABILITIES, BridgeIdentity(bridge), WakeManager(BridgeAlarm(bridge)), power, ShellHands(pkg, userId), callbacks) { Log.w(TAG, it) }
        val server = KernelHostServer(api) { Log.w(TAG, it) }
        server.start()

        // The phone-action whitelist (a virtual screen, a key, starting an app, the app in front) the hand app no longer
        // holds: the kernel host runs them and hands the binder to the hand app's door, so device:phone keeps working.
        pushPhoneActions(ctx, userId)

        val version = runCatching { ctx.packageManager.getPackageInfo(pkg, 0).versionName }.getOrNull() ?: "0"
        supervisor = KernelSupervisor(
            clock = clock,
            provisioner = NoProvision,
            launcher = ShellNodeLauncher(bridge, pkg, paths, sys, api, server, runDir, version),
            env = sys,
            stopped = { false },
            show = { Log.i(TAG, "status: $it") },
            note = { Log.i(TAG, it) },
            onNodeGone = { api.token = null },
            powerSaver = { false },
        )

        // The kernel package stops its own core while this host lives, and tells this host about a wake or a shutdown.
        val cb = object : IHostCallback.Stub() {
            override fun wakeFired(atMs: Long) { supervisor.sendEvent(HostEvents.wakeFired(atMs)) }
            override fun shutdown(reason: String) { Thread({ supervisor.shutdown(reason, 5_000) }, "ash-host-shutdown").start() }
        }
        runCatching { bridge.attach(cb) }

        Thread({ supervisor.run() }, "ash-kernel-host").start()
        Log.i(TAG, "started for $pkg (uid $kernelUid)")
    }

    private const val HAND_PACKAGE = "ai.ash.agent"

    private fun pushPhoneActions(ctx: android.content.Context, userId: Int) {
        try {
            val info = ctx.packageManager.getApplicationInfo(HAND_PACKAGE, 0)
            val build = ctx.packageManager.getPackageInfo(HAND_PACKAGE, 0).lastUpdateTime
            val extras = android.os.Bundle().apply { putBinder("actions", PhoneActions(info.uid, info.sourceDir, build)) }
            val ok = ProviderClient.call("$HAND_PACKAGE.hostshell", userId, "actions", extras)
            Log.i(TAG, "pushed phone actions to $HAND_PACKAGE: ${if (ok != null) "ok" else "no door"}")
        } catch (t: Throwable) {
            Log.w(TAG, "cannot push phone actions", t)
        }
    }
}

/** Installing is done once up front (bridge.provision); the supervisor needs nothing more. */
object NoProvision : Provisioner {
    override fun needsWork() = false
    override fun run(progress: (String) -> Unit) {}
}

/** The owner identity, through the bridge (the Keystore is the kernel package's). */
class BridgeIdentity(private val bridge: IKernelBridge) : Identity {
    override fun publicKey(): ByteArray = Codec.unb64u(bridge.identityKey().substringAfter(' '))
    override fun sign(data: ByteArray): ByteArray = Codec.unb64u(bridge.identitySign(Codec.b64u(data)))
}

class BridgeAlarm(private val bridge: IKernelBridge) : AlarmPort {
    override fun set(atMs: Long) = bridge.alarmSet(atMs)
    override fun cancel() = bridge.alarmCancel()
}

class BridgePower(private val bridge: IKernelBridge) : PowerPort {
    override fun hold(ms: Long, reason: String) = bridge.powerHold(ms, reason)
    override fun release() = bridge.powerRelease()
}
