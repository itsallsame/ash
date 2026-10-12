package ai.ash.kernel.host

import ai.ash.kernel.host.adb.AdbKey
import android.content.Context
import android.os.Process

/**
 * The kernel's host layer, as the owner-facing pairing code sees it. The shell host ([ShellHost]) is started through
 * wireless debugging and attaches to the kernel bridge; [ready] is true once it has. Ash never turns wireless debugging
 * on or off and grants itself nothing — the owner pairs once and opens the switch when asked (see [KernelPairing]).
 */
object KernelHost {
    /** The shell host is attached and supervising the core. */
    fun ready(): Boolean = HostPresence.yielded

    /** 「撤销」: forget the pairing key. The shell host keeps running until the next reboot; the owner can remove the paired device. */
    fun revoke(ctx: Context) = AdbKey.forget(ctx)

    /**
     * The one line the owner's wireless debugging runs: this APK's host code, as the shell user, out of the debugging
     * session (setsid) so turning wireless debugging off leaves it. `& sleep 1` keeps the adb shell a moment so the
     * service leaves the session's process group before the shell ends.
     */
    fun startCommand(ctx: Context): String {
        val info = ctx.packageManager.getApplicationInfo(ctx.packageName, 0)
        val apk = info.sourceDir
        require(apk.none { it == '\'' }) { "unexpected APK path" }
        return "CLASSPATH='$apk' /system/bin/setsid /system/bin/app_process /system/bin --nice-name=ash_kernel_host " +
            "ai.ash.kernel.host.ShellHost ${ctx.packageName} ${info.uid} </dev/null >/dev/null 2>&1 & sleep 1"
    }

    /** How the key names this phone in the paired-devices list. */
    fun keyName(): String = "ash@" + (android.os.Build.MODEL ?: "phone").replace(Regex("[^A-Za-z0-9._-]"), "_")
}
