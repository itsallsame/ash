package ai.ash.caps.config

import ai.ash.caps.screen.KeepAliveSwitches
import android.app.Activity
import android.app.AppOpsManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast

/**
 * The kernel package's 自启动 switch on MIUI and ColorOS. Without it the kernel does not come back by itself after a
 * reboot or after the system kills it (the hand app starts it again whenever it is opened, through the kernel's
 * start activity, so the kernel runs without the switch too). The switch lives in the maker's own settings, which Android
 * does not let an app read in general: MIUI's is app-op 10008, which is tried; ColorOS's cannot be read, so the owner says
 * when it is done. Which phones have it is decided by [Build.MANUFACTURER].
 */
object KernelAutostart {
    enum class Rom { MIUI, COLOROS }

    /** MIUI's app-op for 自启动 (`OP_AUTO_START`). */
    private const val MIUI_OP_AUTO_START = 10008

    fun rom(manufacturer: String?): Rom? = when (manufacturer.orEmpty().lowercase()) {
        "xiaomi", "redmi", "poco" -> Rom.MIUI
        "oppo", "oneplus", "realme" -> Rom.COLOROS
        else -> null
    }

    /** This phone has the switch (and so the guide lists it). */
    fun applies(manufacturer: String? = Build.MANUFACTURER): Boolean = rom(manufacturer) != null

    /** The settings pages of the maker's 自启动 list, (package, class), in the order tried; the app's details page is the last resort. */
    fun pages(rom: Rom): List<Pair<String, String>> = when (rom) {
        Rom.MIUI -> listOf("com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity")
        Rom.COLOROS -> listOf(
            "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
            "com.oplus.battery" to "com.oplus.startupapp.StartupAppListActivity",
            "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
        )
    }

    /** What to do on that page, in the words of the phone's settings. */
    fun guidance(rom: Rom): String = when (rom) {
        Rom.MIUI -> "在「自启动管理」里找到「Ash 内核」，打开它的开关"
        Rom.COLOROS -> "在「自启动」里找到「Ash 内核」，打开它的开关（有的版本要分别打开「开机自启动」和「后台自启动」）"
    }

    /** True / false when the switch can be read, null when it cannot (the owner's word then stands). */
    fun state(ctx: Context): Boolean? {
        if (rom(Build.MANUFACTURER) != Rom.MIUI) return null
        return try {
            val uid = ctx.packageManager.getApplicationInfo(KeepAliveSwitches.KERNEL_PACKAGE, 0).uid
            val ops = ctx.getSystemService(AppOpsManager::class.java)
            val mode = AppOpsManager::class.java.getMethod("checkOpNoThrow", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, String::class.java)
                .invoke(ops, MIUI_OP_AUTO_START, uid, KeepAliveSwitches.KERNEL_PACKAGE) as Int
            mode == AppOpsManager.MODE_ALLOWED
        } catch (_: Throwable) { null }
    }

    /** Opens the maker's 自启动 page, or the kernel's app details when none opens; says what to switch on. Never throws. */
    fun open(a: Activity) {
        val rom = rom(Build.MANUFACTURER) ?: return
        Toast.makeText(a, guidance(rom), Toast.LENGTH_LONG).show()
        for ((pkg, cls) in pages(rom)) {
            try { a.startActivity(Intent().setComponent(ComponentName(pkg, cls)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return } catch (_: Throwable) {}
        }
        try { a.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${KeepAliveSwitches.KERNEL_PACKAGE}"))) } catch (_: Throwable) {}
    }
}
