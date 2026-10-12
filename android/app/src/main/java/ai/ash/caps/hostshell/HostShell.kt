package ai.ash.caps.hostshell

import ai.ash.caps.config.ConfigWatch
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
 * 「后台也能动手」: the phone's debug identity. It is the kernel's own high-privilege host layer now — the kernel package
 * runs it (started through wireless debugging, supervising the brain so the maker's cleaning cannot kill it) and hands this
 * app the short whitelist [IHostShell] (a virtual screen, a key, starting an app, reading the app in front). This app holds
 * no debug identity of its own; it is only a client. The owner pairs and connects it in the kernel's 「Ash 内核」 screen.
 *
 * The kernel host pushes its binder to [HostShellDoor]; this object holds it, and says whether the part is there. The
 * capabilities that need it are offered only while it is ([ai.ash.caps.Capabilities.offered]), and every change is told to
 * the kernel as `config.changed` (item `host_shell`) like any other part of the phone.
 */
object HostShell {
    private const val TAG = "ash.hostshell"
    const val ITEM = "host_shell"

    @Volatile private var shell: IHostShell? = null

    /** The part is there now: the kernel host runs and this app holds its binder. */
    fun ready(): Boolean = shell?.asBinder()?.isBinderAlive == true

    /** One owner-facing line when the part is not there, else null. */
    fun detail(@Suppress("UNUSED_PARAMETER") ctx: Context): String? =
        if (ready()) null else "打开「Ash 内核」，按提示和手机配对一次（约 1 分钟）；手机重启后要再接一下"

    /** For the capabilities' recovery hints (the agent asks the owner). */
    const val HINT = "Ask the owner to connect 「后台也能动手」 in the 「Ash 内核」 screen: the kernel pairs with the phone over " +
        "wireless debugging and keeps the brain alive. Ash cannot do this itself."

    class Absent : IllegalStateException("the phone's debug identity (「后台也能动手」) is not connected")

    // ---- the kernel host hands its whitelist over (HostShellDoor) ----

    /** Takes the kernel host's binder; the answer carries this process's token so the host hears when this process dies. */
    internal fun attach(ctx: Context, binder: IBinder): Bundle? {
        val s = IHostShell.Stub.asInterface(binder) ?: return null
        try { binder.linkToDeath({ gone(binder) }, 0) } catch (e: RemoteException) { return null }
        shell = s
        Log.i(TAG, "connected to the kernel host")
        changed(ctx.applicationContext)
        return Bundle().apply { putBinder("token", TOKEN) }
    }

    private val TOKEN = Binder()

    private fun gone(binder: IBinder) {
        if (shell?.asBinder() !== binder) return
        shell = null
        Log.i(TAG, "the kernel host went away")
    }

    private fun changed(ctx: Context) {
        Link.manifestChanged()
        ConfigWatch.check(ctx)
    }

    // ---- what Ash may do with it ----

    fun key(code: Int, longPress: Boolean) = use { it.key(code, longPress) }

    fun start(intent: Intent) = use { it.start(intent) }

    fun frontApp(): String? = use { it.frontApp() }

    /** Starts Ash's virtual-screen program through the kernel host; it ends when this process goes away. */
    fun openVscreen(): HostProcess = use { s -> Binder().let { owner -> HostProcess(s.openVscreen(owner), owner) } }

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

/** A program the kernel host started for Ash (the virtual-screen program), with its three pipes. */
class HostProcess internal constructor(
    private val remote: IHostProcess,
    /** Keeps the program alive: the host ends it when this binder dies. */
    @Suppress("unused") private val owner: Binder,
) {
    val stdin: OutputStream = ParcelFileDescriptor.AutoCloseOutputStream(remote.stdin())
    val stdout: InputStream = ParcelFileDescriptor.AutoCloseInputStream(remote.stdout())
    val stderr: InputStream = ParcelFileDescriptor.AutoCloseInputStream(remote.stderr())
    fun alive(): Boolean = try { remote.alive() } catch (e: Throwable) { false }
    fun destroy() = try { remote.destroy() } catch (e: Throwable) {}
}
