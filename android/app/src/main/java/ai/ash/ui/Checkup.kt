package ai.ash.ui

import ai.ash.caps.config.ConfigStatus
import ai.ash.caps.config.KernelAutostart
import ai.ash.caps.config.Permissions
import ai.ash.caps.config.ScreenRecovery
import ai.ash.host.KernelLauncher
import ai.ash.host.KernelState
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * 「她的手和眼 · 体检」: what Ash needs from this phone, told as parts of a body (HANDOFF §3) instead of permission names.
 * Seven [Part]s; a part with an item that is not on shows 「去修」 and its page lists each item with one line of why and 「去开启」.
 * Everything here is plain data and rules except [read], which asks the phone; [OnboardingPlan] and [ConfigStatus] are where the
 * items come from, and this file only groups them.
 */
object Checkup {
    /** The parts, in the order the grid shows them. [id] is the one the web page uses (`checkup/<id>`). [optional]: not having it is no trouble. */
    enum class Part(val id: String, val title: String, val optional: Boolean = false) {
        BRAIN("brain", "大脑"),
        ALARM("alarm", "闹钟"),
        NOTIFY("notify", "叫你"),
        AWAKE("awake", "在后台醒着"),
        EYES("eyes", "眼睛和手"),
        FILES("files", "照片和文件"),
        LOCATION("location", "位置和健康（可选）", optional = true);

        companion object { fun of(id: String?): Part? = entries.firstOrNull { it.id == id } }
    }

    /** What the cell says when nothing is wrong, and when something is (the optional part is quiet, not amber). */
    fun cellText(part: Part, todo: Int): String = when {
        todo == 0 -> when (part) {
            Part.BRAIN -> "在运行"; Part.ALARM -> "准时"; Part.NOTIFY -> "会响会振"; Part.AWAKE -> "不会被清理"
            Part.EYES -> "在工作"; Part.FILES -> "能看能找"; Part.LOCATION -> "都开了"
        }
        part.optional -> "没开 · 可选"
        else -> "${trouble(part)} · 去修"
    }

    private fun trouble(part: Part) = when (part) {
        Part.BRAIN -> "可能掉线"; Part.ALARM -> "可能晚几分钟"; Part.NOTIFY -> "可能叫不到你"; Part.AWAKE -> "可能被清理"
        Part.EYES -> "没在工作"; Part.FILES -> "还没给权限"; Part.LOCATION -> "没开"
    }

    enum class State { ON, OFF }

    /**
     * One item of the check. [id] is a name of `config.status` ([ConfigStatus.NAMES]), a key of [Permissions] (the keep-alive switches,
     * the alert sound, the accessibility recovery) or one of the kernel's two own ([KERNEL_PACKAGE], [KERNEL_LINK]).
     * [title] and [why] are the owner's words (「大脑」, never 「内核」); [note] is what the phone says about it when it is off.
     */
    class Item(val id: String, val part: Part, val title: String, val why: String, val state: State, val note: String? = null,
               /** The owner may say it is done (a switch the phone keeps from Ash). */ val awaitsWord: Boolean = false,
               /** Has a 「测试」 button. */ val testable: Boolean = false)

    /** What the items of a part, and of all the parts but the optional one, add up to. */
    class Summary(val parts: Map<Part, Int>) {
        /** Items to deal with, without the optional part (the number the home page shows: 「N 项要处理」). */
        val todo: Int get() = parts.filterKeys { !it.optional }.values.sum()
        fun todo(part: Part): Int = parts[part] ?: 0

        /** `{type:"checkup", todo, groups:[{id, todo}]}` — what the web page is told (UI-SPLIT §3). */
        fun toJson(): JSONObject = JSONObject().put("type", "checkup").put("todo", todo).put("groups", JSONArray().apply {
            Part.entries.forEach { put(JSONObject().put("id", it.id).put("todo", todo(it))) }
        })
    }

    fun summarize(items: List<Item>): Summary = Summary(Part.entries.associateWith { p -> items.count { it.part == p && it.state == State.OFF } })

    const val KERNEL_PACKAGE = "kernel_package"
    const val KERNEL_LINK = "kernel_link"

    /** The catalog: every item, its part and what it says. Which of them the phone has at all is decided in [read]. */
    private class Spec(val id: String, val part: Part, val title: String, val why: String, val testable: Boolean = false)

    private val SPECS = listOf(
        Spec(KERNEL_PACKAGE, Part.BRAIN, "大脑装好了吗", "Ash 的大脑是单独的一个小应用，装上她才能想事情、做事情"),
        Spec(KERNEL_LINK, Part.BRAIN, "大脑在运行", "连上了才能听你说话、替你办事"),
        Spec("kernel_battery_optimization", Part.BRAIN, "大脑不被系统限制", "系统在后台停掉大脑，Ash 就失联了"),
        Spec("kernel_autostart", Part.BRAIN, "大脑自己回来", "手机重启或被系统清理后，大脑自己回来；不开的话，要等你再打开 Ash"),
        Spec("exact_alarm", Part.ALARM, "准时的闹钟", "让提醒准时响起；不开的话，提醒可能晚几分钟"),
        Spec("notifications", Part.NOTIFY, "通知", "提醒、需要你确认的卡片，都靠通知送到你手上"),
        Spec("alerts", Part.NOTIFY, "铃声和振动", "做完了、要你点头、到点提醒时，手机响铃、振动、弹横幅叫你", testable = true),
        Spec("battery_optimization", Part.AWAKE, "不被电池优化限制", "让 Ash 在后台常驻，定时提醒才会准时"),
        Spec("autostart", Part.AWAKE, "自己回来", "被系统清理或重启之后，Ash 自己回来；不开的话，要等你再打开它"),
        Spec("lock", Part.AWAKE, "在最近任务里锁定", "锁定后，系统清理后台时会尽量留下 Ash"),
        Spec("notification_listener", Part.AWAKE, "通知使用权", "系统会一直连着 Ash；被清理后，手机来通知时系统会把它叫回来"),
        Spec("accessibility", Part.EYES, "看懂屏幕", "让 Ash 看懂屏幕内容，替你点击、输入、滚动，也让灵动岛显示在别的应用上方"),
        Spec("overlay", Part.EYES, "悬浮窗", "跨应用显示 Ash 做事的进度，也能小窗看她在后台操作的画面"),
        Spec("shizuku", Part.EYES, "后台也能动手", "装了 Shizuku，Ash 在后台也能替你打开应用、执行命令，不打扰你"),
        Spec("screen_recovery", Part.EYES, "看屏幕的能力掉了自己接上", "系统关掉 Ash 的无障碍后，几秒内自己拉起来，不用你去手动开关"),
        Spec("photos", Part.FILES, "照片、视频和文件", "让 Ash 看你的照片和视频、找手机里的文件、把图片存进相册"),
        Spec("all_files", Part.FILES, "所有文件", "让 Ash 读写手机存储里的所有文件，包括别的应用放在共享存储里的下载和文档"),
        Spec("write_settings", Part.FILES, "改系统设置", "让 Ash 帮你调亮度、屏幕超时这类设置"),
        Spec("usage_access", Part.FILES, "知道你用了什么", "让 Ash 知道你常用哪些应用、用了多久"),
        Spec("location", Part.LOCATION, "位置", "取你现在在哪、记录你去过哪里；数据只存在手机上"),
        Spec("location_background", Part.LOCATION, "不在前台也看位置", "锁屏或没打开 Ash 时，也能取到位置"),
        Spec("activity_recognition", Part.LOCATION, "运动与健身", "计步，分得出你是静止、在走还是在跑"),
        Spec("health", Part.LOCATION, "健康数据", "只读：步数、心率、睡眠、体重这些"),
        Spec("calendar", Part.LOCATION, "日历", "读接下来一天的日程，提前提醒你"),
    )

    /** Keys of [Permissions] for the items that are not names of `config.status` (the phone maker's own switches and the like). */
    private val PERMISSION_KEYS = mapOf("kernel_autostart" to "kernel_autostart", "alerts" to "alerts", "autostart" to "autostart",
        "lock" to "lock", "screen_recovery" to "screen_recovery")

    /**
     * Reads the phone: which items there are and whether each is on. Blocking (Health Connect may take a moment): not on the main thread.
     * Items the phone cannot have (an Android without the permission, no Health Connect, a phone that does not ask for auto-start) are left out,
     * and the kernel's own switches wait until the kernel is installed.
     */
    fun read(ctx: Context): List<Item> {
        val kernel = KernelLauncher.state(ctx)
        return SPECS.mapNotNull { spec ->
            fun item(on: Boolean, note: String? = null, awaits: Boolean = false) =
                Item(spec.id, spec.part, spec.title, spec.why, if (on) State.ON else State.OFF, if (on) null else note, awaits, spec.testable)
            when (spec.id) {
                KERNEL_PACKAGE -> item(kernel != KernelState.NOT_INSTALLED, "还没装")
                KERNEL_LINK -> item(kernel == KernelState.BOUND, if (kernel == KernelState.NOT_INSTALLED) "先装好大脑" else "连不上，点「去开启」叫醒它")
                "kernel_battery_optimization", "kernel_autostart" -> {
                    if (kernel == KernelState.NOT_INSTALLED || (spec.id == "kernel_autostart" && !KernelAutostart.applies())) return@mapNotNull null
                    val p = if (spec.id == "kernel_autostart") Permissions.all.firstOrNull { it.key == "kernel_autostart" } else null
                    if (p != null) item(p.granted(ctx), p.status(ctx), p.awaitsWord(ctx))
                    else ConfigStatus.item(ctx, spec.id).let { item(it.state == ConfigStatus.GRANTED, null) }
                }
                else -> {
                    val key = PERMISSION_KEYS[spec.id]
                    if (key != null) {
                        val p = Permissions.all.firstOrNull { it.key == key } ?: return@mapNotNull null
                        if (spec.id == "screen_recovery") item(ScreenRecovery.granted(ctx), p.status(ctx))
                        else item(p.granted(ctx), p.status(ctx), p.awaitsWord(ctx))
                    } else {
                        val r = ConfigStatus.item(ctx, spec.id)
                        when (r.state) {
                            ConfigStatus.UNSUPPORTED -> null
                            else -> {
                                val p = ConfigStatus.PERMISSION_KEY[spec.id]?.let { k -> Permissions.all.firstOrNull { it.key == k } }
                                item(r.state == ConfigStatus.GRANTED, p?.status(ctx), p?.awaitsWord(ctx) == true)
                            }
                        }
                    }
                }
            }
        }
    }

    fun summary(ctx: Context): Summary = summarize(read(ctx))
}
