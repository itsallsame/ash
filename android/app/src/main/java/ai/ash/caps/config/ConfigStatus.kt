package ai.ash.caps.config

import ai.ash.caps.senses.Senses
import ai.ash.caps.senses.health.HealthConnectSource
import android.app.AlarmManager
import android.content.Context
import android.os.Build
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject

/**
 * The state of the permissions and switches the app needs (`config.status`), by the names of the standard `config`
 * namespace. What Android lets the app read is read; the phone maker's own switches are the keep-alive status
 * ([KeepAliveStatus]), because only the owner's word vouches for them.
 */
object ConfigStatus {
    const val GRANTED = "granted"
    const val MISSING = "missing"
    const val UNSUPPORTED = "unsupported"

    /** The package of the kernel, whose battery exemption matters as much as this app's. */
    private const val KERNEL_PACKAGE = ai.ash.caps.screen.KeepAliveSwitches.KERNEL_PACKAGE

    class Item(val item: String, val state: String, val detail: String? = null) {
        fun toJson(): JSONObject = JSONObject().put("item", item).put("state", state).apply { if (!detail.isNullOrEmpty()) put("detail", detail) }
    }

    /** The names `config.permission.request` takes and `config.status` lists, in that order. */
    val NAMES = listOf(
        "accessibility", "notification_listener", "notifications", "exact_alarm", "battery_optimization", "kernel_battery_optimization",
        "location", "location_background", "activity_recognition", "health", "calendar", "photos", "all_files", "overlay", "write_settings",
        "host_shell", "usage_access",
    )

    /** The entry of [Permissions] (the owner-facing list) each name is, for the names that have one. */
    internal val PERMISSION_KEY = mapOf(
        "accessibility" to "accessibility", "notification_listener" to "notification_access", "notifications" to "notifications",
        "battery_optimization" to "battery", "calendar" to "calendar", "photos" to "photos", "all_files" to "all_files",
        "overlay" to "overlay", "write_settings" to "write_settings", "host_shell" to "host_shell", "usage_access" to "usage",
    )

    fun all(ctx: Context): List<Item> = NAMES.map { item(ctx, it) }

    fun item(ctx: Context, name: String): Item = try {
        read(ctx, name)
    } catch (e: Throwable) {
        Item(name, MISSING, "could not be read: ${e.javaClass.simpleName}")
    }

    private fun read(ctx: Context, name: String): Item {
        PERMISSION_KEY[name]?.let { key ->
            val permission = Permissions.all.firstOrNull { it.key == key } ?: return Item(name, UNSUPPORTED, "this Android version has no such permission")
            return if (permission.ready(ctx)) Item(name, GRANTED) else Item(name, MISSING, permission.status(ctx))
        }
        return when (name) {
            "exact_alarm" ->
                if (Build.VERSION.SDK_INT < 31 || ctx.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()) Item(name, GRANTED)
                else Item(name, MISSING, "reminders may come a few minutes late")
            "kernel_battery_optimization" -> when {
                runCatching { ctx.packageManager.getPackageInfo(KERNEL_PACKAGE, 0) }.isFailure -> Item(name, MISSING, "the kernel package is not installed")
                ctx.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(KERNEL_PACKAGE) -> Item(name, GRANTED)
                else -> Item(name, MISSING, "the system may stop the kernel in the background")
            }
            "location" -> flag(name, Senses.locationPermission(ctx))
            "location_background" -> flag(name, Senses.backgroundLocation(ctx), "location is only followed while the app is in front")
            "activity_recognition" -> flag(name, Senses.activityRecognition(ctx))
            "health" -> when (HealthConnectSource.state(ctx)) {
                "available" -> flag(name, HealthConnectSource.PERMISSIONS.any { it in HealthConnectSource.granted(ctx) })
                "update_required" -> Item(name, UNSUPPORTED, "Health Connect needs an update")
                else -> Item(name, UNSUPPORTED, "Health Connect is not installed")
            }
            else -> throw IllegalArgumentException("unknown item $name")
        }
    }

    private fun flag(name: String, granted: Boolean, whyMissing: String? = null) = if (granted) Item(name, GRANTED) else Item(name, MISSING, whyMissing)

    fun toJson(items: List<Item>): JSONArray = JSONArray().apply { items.forEach { put(it.toJson()) } }

    /** One line per item, for the model. */
    fun render(items: List<Item>): String = items.joinToString("\n") { "${it.item}: ${it.state}" + (it.detail?.let { d -> " ($d)" } ?: "") }
}

/**
 * The keep-alive switches the phone keeps (`config.keepalive.status`): what Android reports of the battery exemption, and
 * the phone maker's own switches, which only the owner's word vouches for (see [Permission.confirmable]).
 */
object KeepAliveStatus {
    /** The entry of [Permissions] each item is. */
    private val ITEMS = listOf("battery_optimization" to "battery", "autostart" to "autostart", "kernel_autostart" to "kernel_autostart", "recents_lock" to "lock")

    /** The phone maker has switches of its own that this app cannot read. */
    fun supported(): Boolean = PhoneMaker.current.ownSwitches

    fun items(ctx: Context): List<ConfigStatus.Item> = ITEMS.mapNotNull { (item, key) ->
        val permission = Permissions.all.firstOrNull { it.key == key } ?: return@mapNotNull null
        if (permission.granted(ctx)) ConfigStatus.Item(item, ConfigStatus.GRANTED)
        else ConfigStatus.Item(item, ConfigStatus.MISSING, permission.status(ctx))
    }
}
