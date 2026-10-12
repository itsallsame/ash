package ai.ash.caps.config

import ai.ash.caps.Cap
import ai.ash.caps.CapResult
import ai.ash.caps.Capability
import ai.ash.caps.Effect
import ai.ash.caps.Risk
import ai.ash.caps.prop
import ai.ash.caps.result
import ai.ash.caps.schema
import org.json.JSONObject

/**
 * `config.*`: the app's own permissions and switches. These are host services the owner grants: Ash reads their state and
 * puts the right prompt or settings page in front of the owner, and never switches one itself.
 */
object ConfigCapabilities {
    private val status = Cap(
        name = "config.status",
        description = "The state of every permission and switch the Ash app needs: accessibility, notification listener, notifications, exact " +
            "alarms, battery optimization (the app and the kernel), location (and in the background), activity recognition, health, calendar, photos " +
            "and files, all-files access, overlay, modify system settings, the phone's debug identity (「后台也能动手」, host_shell) and usage access. " +
            "Each is granted, missing (with why) or unsupported on this phone.",
        effect = Effect.READ, risk = Risk.NONE, label = "在看手机App的权限和开关",
        result = result("items:array!"),
    ) { ctx, _ ->
        val items = ConfigStatus.all(ctx)
        CapResult.text(ConfigStatus.render(items), JSONObject().put("items", ConfigStatus.toJson(items)))
    }

    private val request = Cap(
        name = "config.permission.request",
        description = "Put the system's permission prompt, or the settings page that holds the switch, in front of the owner for one permission " +
            "or switch they have to grant by hand. Nothing is granted by this call; check config.status afterwards. Nothing is shown for one that is already granted.",
        schema = schema("name" to prop("string", "Which permission or switch.", required = true, enum = ConfigStatus.NAMES)),
        effect = Effect.ACT, risk = Risk.NONE, label = "在请求权限", foreground = true,
        result = result("requested:boolean"),
    ) { ctx, args ->
        val name = args.optString("name")
        if (name !in ConfigStatus.NAMES) return@Cap CapResult.error("bad_request", "name must be one of ${ConfigStatus.NAMES.joinToString()}")
        if (ConfigStatus.item(ctx, name).state == ConfigStatus.GRANTED) return@Cap CapResult.text("$name is already granted.", JSONObject().put("requested", false))
        PermissionRequest.start(ctx, name)
        CapResult.text("Asked the owner for $name; check config.status for the outcome.", JSONObject().put("requested", true))
    }

    private val keepaliveStatus = Cap(
        name = "config.keepalive.status",
        description = "The switches that keep Ash running in the background: the battery exemption, the phone maker's auto-start and background " +
            "settings, and the locked card in recent apps. The maker's own switches cannot be read, so they count as on only once the owner said so. " +
            "supported tells whether this phone's maker has switches of its own.",
        effect = Effect.READ, risk = Risk.NONE, label = "在看保活状态",
        result = result("supported:boolean", "items:array!"),
    ) { ctx, _ ->
        val items = KeepAliveStatus.items(ctx)
        CapResult.text(ConfigStatus.render(items), JSONObject().put("supported", KeepAliveStatus.supported()).put("items", ConfigStatus.toJson(items)))
    }

    val list: List<Capability> = listOf(status, request, keepaliveStatus)
}
