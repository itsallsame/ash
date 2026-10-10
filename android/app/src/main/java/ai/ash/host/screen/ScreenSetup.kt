package ai.ash.host.screen

import android.app.Activity
import android.content.Intent
import android.provider.Settings
import android.widget.Toast

/** The screen side's owner-facing setup: where the accessibility switch is, and the recovery grant. */
object ScreenSetup {
    /**
     * Grants Ash the one permission recovery needs: through Shizuku when it is running, otherwise it shows the adb
     * command (copied, for a computer the phone is plugged into).
     */
    fun grantRecovery(a: Activity) {
        if (ai.ash.host.shizuku.ShizukuState.ready()) {
            val ctx = a.applicationContext
            Thread({
                val r = runCatching { ai.ash.host.shizuku.PrivShell.exec(ctx, "pm grant ${ctx.packageName} android.permission.WRITE_SECURE_SETTINGS", 15_000) }.getOrNull()
                android.os.Handler(android.os.Looper.getMainLooper()).post {
                    Toast.makeText(ctx, if (r?.ok == true) "已授权：无障碍被清理后会自动恢复" else "授权没有成功：${r?.stderr?.take(80) ?: "Shizuku 不可用"}", Toast.LENGTH_LONG).show()
                }
            }, "ash-grant-recovery").start()
            return
        }
        val command = ScreenRecovery.grantCommand(a)
        a.getSystemService(android.content.ClipboardManager::class.java).setPrimaryClip(android.content.ClipData.newPlainText("adb", command))
        android.app.AlertDialog.Builder(a).setTitle("授权一次")
            .setMessage("把手机用 USB 连上电脑（打开 USB 调试），在电脑上运行下面这行（已复制）：\n\n$command\n\n只需一次，之后一直有效。")
            .setPositiveButton("好的", null).show()
    }

    /** Where the owner turns Ash's accessibility service on. */
    fun openAccessibility(a: Activity) {
        Toast.makeText(a, "在列表里找到「Ash」并打开", Toast.LENGTH_LONG).show()
        a.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }
}
