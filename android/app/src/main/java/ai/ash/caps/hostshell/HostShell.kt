package ai.ash.caps.hostshell

import ai.ash.caps.config.ConfigWatch
import ai.ash.caps.hostshell.adb.AdbKey
import ai.ash.link.Link
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Bundle
import android.os.DeadObjectException
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.os.RemoteException
import android.util.Log
import java.io.InputStream
import java.io.OutputStream

/**
 * 「后台也能动手」: the phone's debug identity, a host service like the accessibility service. The owner grants it by pairing
 * Ash with the phone in wireless debugging and starts it again after a restart ([HostShellGuide] leads them); Ash never turns
 * wireless debugging on or off, grants itself nothing and changes no setting for it. What Ash may do with it is the short list
 * in [IHostShell] (a virtual screen, a key, starting an app, reading the app in front), each through its own capability and
 * its approval; there is no way to run a command through it.
 *
 * The service ([Server]) hands its binder to [HostShellDoor]; this object holds it, and says whether the part is there. The
 * capabilities that need it are offered only while it is ([ai.ash.caps.Capabilities.offered]), and every change is told to
 * the kernel as `config.changed` (item `host_shell`) like any other part of the phone.
 */
object HostShell {
    private const val TAG = "ash.hostshell"
    const val ITEM = "host_shell"

    enum class State { NOT_PAIRED, ABSENT, READY }

    @Volatile private var shell: IHostShell? = null
    /** Lives as long as this process: the service watches it to know when to hand its binder over again. */
    private val token = Binder()

    /** The part is there now: the service runs and Ash holds its binder. */
    fun ready(): Boolean = shell?.asBinder()?.isBinderAlive == true

    fun state(ctx: Context): State = when {
        ready() -> State.READY
        AdbKey.exists(ctx) -> State.ABSENT
        else -> State.NOT_PAIRED
    }

    /** One owner-facing line when the part is not there, else null. */
    fun detail(ctx: Context): String? = when (state(ctx)) {
        State.READY -> null
        State.ABSENT -> "手机重启过或服务停了：点「去开启」，打开「无线调试」，接好后再关掉"
        State.NOT_PAIRED -> "要在「无线调试」里和手机配对一次（约 1 分钟）"
    }

    /** For the capabilities' recovery hints (the agent asks the owner). */
    const val HINT = "Ask the owner to connect 「后台也能动手」 (the phone's debug identity) in Ash's checkup: the owner turns on Wireless " +
        "debugging when Ash asks, and off again once Ash says it is connected. Ash cannot do this itself."

    class Absent : IllegalStateException("the phone's debug identity (「后台也能动手」) is not connected")

    /**
     * The one line the owner's wireless debugging runs for Ash (through [ai.ash.caps.hostshell.adb.AdbClient.shell]): the
     * service from this APK, as the shell user, out of the debugging session so that turning wireless debugging off leaves it.
     * The shell waits a second before it ends: adbd ends what is still in the session's process group when the shell is
     * gone, and the service needs that moment to leave it (setsid).
     */
    fun startCommand(ctx: Context): String {
        val apk = ctx.applicationInfo.sourceDir
        require(apk.none { it == '\'' }) { "unexpected APK path" }
        return "CLASSPATH='$apk' " + Server.command(apk, ctx.packageName, android.os.Process.myUid()).joinToString(" ") +
            " </dev/null >/dev/null 2>&1 & sleep 1"
    }

    // ---- the service hands itself over (HostShellDoor) ----

    /** Takes the service's binder when it is of this very build (an older one replaces itself first); the answer carries this process's token. */
    internal fun attach(ctx: Context, binder: IBinder): Bundle? {
        val s = IHostShell.Stub.asInterface(binder)
        val mine = runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).lastUpdateTime }.getOrNull() ?: return null
        val theirs = try { s.build() } catch (e: RemoteException) { return null }
        if (theirs != mine) {
            Log.w(TAG, "a service of another build ($theirs, this is $mine): not taken")
            return null
        }
        try { binder.linkToDeath({ gone(ctx.applicationContext, binder) }, 0) } catch (e: RemoteException) { return null }
        shell = s
        Log.i(TAG, "connected")
        changed(ctx.applicationContext)
        return Bundle().apply { putBinder("token", token) }
    }

    private fun gone(ctx: Context, binder: IBinder) {
        if (shell?.asBinder() !== binder) return
        shell = null
        Log.i(TAG, "the service went away")
        changed(ctx)
    }

    private fun changed(ctx: Context) {
        Link.manifestChanged()
        ConfigWatch.check(ctx)
        HostShellGuide.changed(ctx)
    }

    // ---- what Ash may do with it ----

    fun key(code: Int, longPress: Boolean) = use { it.key(code, longPress) }

    fun start(intent: Intent) = use { it.start(intent) }

    fun frontApp(): String? = use { it.frontApp() }

    /** Starts Ash's virtual-screen program as the shell user; it ends when this process goes away. */
    fun openVscreen(): HostProcess = use { s -> Binder().let { owner -> HostProcess(s.openVscreen(owner), owner) } }

    /** 「撤销」: stops the service and forgets the pairing key (the owner removes Ash from the paired devices themself). */
    fun revoke(ctx: Context) {
        runCatching { shell?.exit() }
        shell = null
        AdbKey.forget(ctx)
        changed(ctx.applicationContext)
    }

    private inline fun <T> use(f: (IHostShell) -> T): T {
        val s = shell ?: throw Absent()
        try {
            return f(s)
        } catch (e: DeadObjectException) {
            throw Absent()
        } catch (e: RemoteException) {
            throw IllegalStateException("the debug identity did not answer: ${e.message}")
        }
    }
}

/** A program the service started for Ash (the virtual-screen program), with its three pipes. */
class HostProcess internal constructor(
    private val remote: IHostProcess,
    /** Keeps the program alive: the service ends it when this binder dies. */
    @Suppress("unused") private val owner: Binder,
) {
    val stdin: OutputStream = ParcelFileDescriptor.AutoCloseOutputStream(remote.stdin())
    val stdout: InputStream = ParcelFileDescriptor.AutoCloseInputStream(remote.stdout())
    val stderr: InputStream = ParcelFileDescriptor.AutoCloseInputStream(remote.stderr())
    fun alive(): Boolean = try { remote.alive() } catch (e: Throwable) { false }
    fun destroy() = try { remote.destroy() } catch (e: Throwable) {}
}
