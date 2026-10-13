package ai.ash.caps.hostshell

import ai.ash.caps.config.ConfigWatch
import ai.ash.link.Link
import android.content.Context
import android.os.IBinder
import android.os.RemoteException
import android.util.Log

/**
 * 「后台也能动手」: the phone's debug identity. It is the kernel's own high-privilege host layer — the kernel package runs
 * it (started through wireless debugging, supervising the brain so the maker's cleaning cannot kill it) and serves what
 * it can do (a virtual screen, keys, launching an app) to the brain directly, as `service:host`. This app holds no debug
 * identity and is on no path of it: it only shows whether the part is there.
 *
 * With the brain's link details the kernel host hands [HostShellDoor] a token (a binder with nothing on it): it is alive
 * while the host is. Every change is told to the kernel as `config.changed` (item `host_shell`) like any other part.
 */
object HostShell {
    private const val TAG = "ash.hostshell"
    const val ITEM = "host_shell"

    @Volatile private var token: IBinder? = null

    /** The part is there now: the kernel host runs. */
    fun ready(): Boolean = token?.isBinderAlive == true

    /** One owner-facing line when the part is not there, else null. */
    fun detail(@Suppress("UNUSED_PARAMETER") ctx: Context): String? =
        if (ready()) null else "打开「Ash 内核」，按提示和手机配对一次（约 1 分钟）；手机重启后要再接一下"

    /** Takes the kernel host's token; tells the kernel when the part comes and goes. */
    internal fun attach(ctx: Context, binder: IBinder) {
        if (token === binder) return
        try { binder.linkToDeath({ gone(ctx.applicationContext, binder) }, 0) } catch (e: RemoteException) { return }
        token = binder
        Log.i(TAG, "the kernel host is there")
        changed(ctx.applicationContext)
    }

    private fun gone(ctx: Context, binder: IBinder) {
        if (token !== binder) return
        token = null
        Log.i(TAG, "the kernel host went away")
        changed(ctx)
    }

    private fun changed(ctx: Context) {
        Link.manifestChanged()
        ConfigWatch.check(ctx)
    }
}
