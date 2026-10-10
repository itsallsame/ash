package ai.ash.caps.config

import ai.ash.caps.Cap
import ai.ash.caps.CapResult
import ai.ash.caps.Capability
import ai.ash.caps.Effect
import ai.ash.caps.Risk
import ai.ash.caps.prop
import ai.ash.caps.result
import ai.ash.caps.schema
import ai.ash.caps.screen.Screen
import org.json.JSONObject

/**
 * `config.*`: the app's own permissions and switches. The owner's settings page and an agent use the same words; the
 * kernel's gate decides what needs asking (a request or a fix changes the owner's phone settings, so it does).
 */
object ConfigCapabilities {
    private val status = Cap(
        name = "config.status",
        description = "The state of every permission and switch the Ash app needs: accessibility, notification listener, notifications, exact " +
            "alarms, battery optimization (the app and the kernel), location (and in the background), activity recognition, health, calendar, photos " +
            "and files, all-files access, overlay, modify system settings, Shizuku and usage access. Each is granted, missing (with why) or unsupported on this phone.",
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
            "settings, and the locked card in recent apps. The maker's own switches cannot be read, so they count as on only once the owner said so " +
            "or config.keepalive.fix saw them on. supported tells whether this phone's maker has switches of its own.",
        effect = Effect.READ, risk = Risk.NONE, label = "在看保活状态",
        result = result("supported:boolean", "items:array!"),
    ) { ctx, _ ->
        val items = KeepAliveStatus.items(ctx)
        CapResult.text(ConfigStatus.render(items), JSONObject().put("supported", KeepAliveStatus.supported()).put("items", ConfigStatus.toJson(items)))
    }

    private val keepaliveFix = Cap(
        name = "config.keepalive.fix",
        description = "Turn on the background-running switches of Ash's own apps in the phone maker's settings, by driving them through " +
            "accessibility (ColorOS only; the result says unsupported elsewhere). Switches that are on are left alone. It takes over the screen " +
            "for a minute or two: the owner must not touch the phone meanwhile. Needs the accessibility service.",
        schema = schema("packages" to JSONObject().put("type", "array").put("items", JSONObject().put("type", "string"))
            .put("description", "Which of Ash's apps (default all of them).")),
        availableIf = { Screen.accessibility() },
        effect = Effect.ACT, risk = Risk.STRUCTURE, label = "在打开保活开关", foreground = true,
        result = result("outcome:string", "summary:string"),
    ) { ctx, args ->
        val packages = args.optJSONArray("packages")?.let { l -> (0 until l.length()).map { l.optString(it) } }.orEmpty()
        val asked = KeepAliveFix.targets(ctx, packages)
        val report = KeepAliveFix.run(ctx, asked) ?: return@Cap CapResult.error("unavailable", "another keep-alive run is going")
        val summary = report.summary(asked)
        CapResult.text(summary, report.toJson().put("summary", summary))
    }

    private val enableAccessibility = Cap(
        name = "config.accessibility.enable",
        description = "Turn Ash's accessibility service back on, which the system switches off after an upgrade. Works only when the app holds the " +
            "secure-settings permission (granted once over adb or Shizuku); without it the owner has to switch it on in the system's accessibility settings.",
        effect = Effect.WRITE, risk = Risk.STRUCTURE, label = "在重新打开无障碍服务",
        result = result("enabled:boolean!"),
    ) { ctx, _ ->
        when (ScreenRecovery.enable(ctx)) {
            ScreenRecovery.Enable.NOT_PERMITTED ->
                CapResult.error("forbidden", "the app does not hold WRITE_SECURE_SETTINGS (grant it once with: ${ScreenRecovery.grantCommand(ctx)}); the owner can switch the service on in accessibility settings")
            else -> {
                // The system starts the service a moment after the setting is written.
                val end = System.currentTimeMillis() + 5_000
                while (!Screen.accessibility() && System.currentTimeMillis() < end) Thread.sleep(100)
                val on = Screen.accessibility()
                CapResult.text(if (on) "The accessibility service is on." else "The setting is written but the service has not started yet.", JSONObject().put("enabled", on))
            }
        }
    }

    val list: List<Capability> = listOf(status, request, keepaliveStatus, keepaliveFix, enableAccessibility)
}
