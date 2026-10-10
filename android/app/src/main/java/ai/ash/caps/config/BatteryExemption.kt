package ai.ash.caps.config

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings

/** Opens the battery-exemption page for Ash without the system's "choose an app" box (see [BatteryExemptionRoute]). */
object BatteryExemption {
    /** The intent to start: only the owner's tap may start it. */
    fun intent(ctx: Context): Intent {
        val pm = ctx.packageManager
        val own = Uri.parse("package:${ctx.packageName}")
        val request = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, own)
        val list = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        fun who(i: Intent) = runCatching { pm.queryIntentActivities(i, 0).map { it.activityInfo.packageName } }.getOrDefault(emptyList())
        val route = BatteryExemptionRoute.choose(who(request), who(list))
        val base = when (route.page) {
            BatteryExemptionRoute.Page.REQUEST -> request
            BatteryExemptionRoute.Page.LIST -> list
            BatteryExemptionRoute.Page.DETAILS -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, own)
        }
        return base.apply { route.pkg?.let { setPackage(it) } }
    }

    fun open(ctx: Context) = ctx.startActivity(intent(ctx))

    /** The list of apps, where the owner finds [pkg] (the kernel); its app-info page if the list cannot be opened without a question. */
    fun openList(ctx: Context, pkg: String) {
        val list = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        val who = runCatching { ctx.packageManager.queryIntentActivities(list, 0).map { it.activityInfo.packageName } }.getOrDefault(emptyList())
        val route = BatteryExemptionRoute.choose(emptyList(), who)
        ctx.startActivity(
            if (route.page == BatteryExemptionRoute.Page.LIST) list.apply { route.pkg?.let { setPackage(it) } }
            else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg")),
        )
    }
}
