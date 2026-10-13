package ai.ash.ui

import ai.ash.R

/**
 * What she says on each screen of the guide, in the owner's words (design/app/reference/Copy.html: short, first person, no
 * codes). One entry per item the guide can ask about; [OnboardingPlan.ASK_ORDER] says in which order. Pure data: the
 * activity draws it, the test reads it.
 *
 * `**word**` in [PageCopy.say] is the one word that carries the sentence (drawn heavier).
 */
internal object OnboardingContent {
    /** Which of the two templates draws the screen. */
    enum class Look {
        /** 一次一件: she says why, a small example shows what the owner gets. */
        ASK,
        /** 要你亲手开的: she says why, and the row to switch in the system's settings is drawn. */
        HAND,
    }

    /** What the little example shows: a line like the one she would send. */
    class Preview(val title: String, val whenText: String, val body: String, val caption: String)

    /** The settings page the owner goes to, drawn as the system shows it. */
    class Hand(val path: String, val step1: String)

    class PageCopy(
        /** The short name: the tag on the closing screen and the label of the item. */
        val name: String,
        val say: String,
        val look: Look,
        val primary: String,
        val icon: Int,
        /** The avatar beside her words (the island's expression names). */
        val expression: String = "default",
        val preview: Preview? = null,
        val hand: Hand? = null,
    )

    private fun ask(name: String, say: String, primary: String, icon: Int, preview: Preview, expression: String = "default") =
        PageCopy(name, say, Look.ASK, primary, icon, expression, preview = preview)

    private fun hand(name: String, say: String, icon: Int, path: String, step1: String, primary: String = "去打开") =
        PageCopy(name, say, Look.HAND, primary, icon, "listening", hand = Hand(path, step1))

    private fun ping(whenText: String, body: String, caption: String) = Preview("Ash", whenText, body, caption)

    val pages: Map<String, PageCopy> = mapOf(
        "notifications" to ask(
            "通知", "到点提醒你、要你确认的事，我都靠**通知**告诉你。", "好，打开通知", R.drawable.ash_ic_bell,
            ping("现在", "07:45 了，该出门了，外面有点凉。", "开了之后，你会收到这样的提醒"),
        ),
        "exact_alarm" to hand(
            "精确闹钟", "你让我几点叫你，我就想**准点**叫。这一项要你亲手打开，我陪你走一遍：", R.drawable.ash_ic_alarm,
            "系统设置 › 闹钟和提醒", "点下面的按钮，会跳到系统的「闹钟和提醒」",
        ),
        "battery_optimization" to ask(
            "在后台醒着", "我得在后台**醒着**，才能准点提醒你。系统会问你一次，请选「允许」。", "好，让她醒着", R.drawable.ash_ic_bolt,
            ping("07:45", "早，今天 9 点有个会，我帮你记着。", "开了之后，系统不会把我睡过去"),
        ),
        "autostart" to ask(
            "自启动", "手机重启、或者被系统清理之后，我想**自己回来**。这要在手机自带的设置里开一下。", "去打开", R.drawable.ash_ic_refresh,
            ping("刚刚", "我回来了，刚才没做完的事接着做。", "开了之后，被清理了我也会自己回来"),
        ),
        "kernel_lock" to ask(
            "锁住大脑", "我的**大脑**在最近任务里有自己的一张卡片。把它锁住，系统清理后台的时候，就会留下它。", "去锁定", R.drawable.ash_ic_lock,
            ping("刚刚", "清理了一圈，我的大脑还在。", "锁住之后，一键清理也会留着它"),
        ),
        "kernel_battery_optimization" to ask(
            "大脑常驻", "我的**大脑**也要在后台醒着，不然我会突然失联。", "好，让大脑醒着", R.drawable.ash_ic_cpu,
            ping("现在", "大脑一直在线，随叫随到。", "开了之后，我不会半夜失联"),
        ),
        "kernel_autostart" to ask(
            "大脑自启动", "手机重启之后，我的**大脑**也要自己回来。这要在手机自带的设置里开一下。", "去打开", R.drawable.ash_ic_cpu,
            ping("刚刚", "手机重启了，我已经回来。", "开了之后，重启不用你来叫我"),
        ),
        "accessibility" to hand(
            "无障碍", "我想看懂屏幕、替你点按。这一项要你**亲手**打开，我陪你走一遍：", R.drawable.ash_ic_eye,
            "系统设置 › 无障碍 › 已下载的应用", "点下面的按钮，会跳到系统的无障碍设置",
        ),
        "notification_listener" to hand(
            "读通知", "你收到的通知我也想**读**到，比如快递和验证码。这一项也要你亲手打开：", R.drawable.ash_ic_msg,
            "系统设置 › 通知使用权", "点下面的按钮，会跳到系统的「通知使用权」",
        ),
        "overlay" to hand(
            "悬浮窗", "我做事的时候，想在别的应用上方给你看**进度**。这一项要你在系统里打开：", R.drawable.ash_ic_widget,
            "系统设置 › 悬浮窗", "点下面的按钮，会跳到系统的「悬浮窗」",
        ),
        "host_shell" to ask(
            "后台也能动手", "和手机**配对**一次（大约 1 分钟，要打开开发者选项），我在后台也能替你打开应用、按键、用虚拟屏，不打扰你。不想弄的话先不用。", "去配对", R.drawable.ash_ic_box,
            ping("刚刚", "我在后台把那份表格发出去了。", "开了之后，我做事不用占着你的屏幕"),
            expression = "focused",
        ),
        "photos" to ask(
            "照片和文件", "你想让我看某张**照片**、找手机里的文件，我得先得到你的许可。", "好，允许访问", R.drawable.ash_ic_image,
            ping("现在", "找到了，是上周五拍的那张发票。", "开了之后，我能帮你找照片和文件"),
        ),
        "calendar" to ask(
            "日历", "我看得到你的**日程**，才能提前提醒你。", "好，允许读日历", R.drawable.ash_ic_clock,
            ping("08:30", "10 点有个会，现在出门正好。", "开了之后，日程快到了我会提前叫你"),
        ),
        "all_files" to hand(
            "所有文件", "想让我整理你手机里的**文件**，比如下载和文档，要打开「所有文件访问」。", R.drawable.ash_ic_folder,
            "系统设置 › 所有文件访问", "点下面的按钮，会跳到系统的「所有文件访问」",
        ),
        "write_settings" to hand(
            "修改系统设置", "想让我帮你调亮度、屏幕超时这些，就要允许我**修改系统设置**。", R.drawable.ash_ic_slider,
            "系统设置 › 修改系统设置", "点下面的按钮，会跳到系统的「修改系统设置」",
        ),
        "usage_access" to hand(
            "使用情况", "知道你常用哪些应用、用了多久，我就能更**贴心**。这一项也要你亲手打开：", R.drawable.ash_ic_pulse,
            "系统设置 › 使用情况访问", "点下面的按钮，会跳到系统的「使用情况访问」",
        ),
        "location" to ask(
            "位置", "知道你在**哪里**，我才能在你到家、到公司的时候说对的话。数据只存在手机上。", "好，允许位置", R.drawable.ash_ic_pin,
            ping("现在", "你到公司了，今天要带的东西都在包里吗？", "开了之后，我会按你所在的地方提醒"),
        ),
        "location_background" to ask(
            "后台位置", "锁屏、或者不在前台的时候，我也想知道你在**哪里**。这一项要选「始终允许」。", "好，始终允许", R.drawable.ash_ic_pin,
            ping("刚刚", "你回到家了，今天走了 8000 步。", "开了之后，锁屏时我也知道你到了哪"),
        ),
        "activity_recognition" to ask(
            "运动与健身", "我想知道你是在走路、跑步还是坐着，还有今天走了多少**步**。", "好，允许运动", R.drawable.ash_ic_pulse,
            ping("现在", "今天走了 6200 步，比昨天多一点。", "开了之后，我能替你数步数"),
        ),
        "health" to ask(
            "健康数据", "步数、心率、睡眠、体重，我可以从系统的**健康连接**里只读地看一眼。数据只存在手机上。", "好，允许读取", R.drawable.ash_ic_heart,
            ping("早上", "昨晚睡了 7 小时，比平时多一些。", "开了之后，我会按你的状态说话"),
        ),
    )

    /** An item the guide does not know yet still gets a screen: its name, and the plain button. */
    fun of(item: String, fallbackName: String, fallbackWhy: String): PageCopy = pages[item]
        ?: PageCopy(fallbackName, if (fallbackWhy.isEmpty()) "还有一项：**$fallbackName**。" else "还有一项：**$fallbackName**。$fallbackWhy", Look.ASK, "去开启", R.drawable.ash_ic_check)

    /** The second and third lines of the hand-drawn steps. */
    const val HAND_STEP_2 = "找到「Ash」，把开关打开"
    const val HAND_STEP_3 = "按返回，回到这里"

    /** What she says on the screens that are not an item. */
    object Words {
        const val WELCOME_TITLE = "你好，我是 Ash"
        const val WELCOME_BODY = "我会住在你的手机里，帮你记事、提醒、跑腿。\n先花两分钟，让我准备好。"
        const val START = "开始"
        const val BRAIN_TITLE = "我先把自己的大脑装好"
        const val SKIP = "先不用"
        const val RECHECK = "再检查一次"
        const val CHECKING = "正在检查…"
        const val SAID_BUTTON = "我已经打开了"
        /** What a screen the owner went back to says of an item they told Ash is on. */
        const val SAID_MARK = "你说已开"
        const val DONE_TITLE = "准备好了"
        const val DONE_BUTTON = "去跟她说话"
    }
}
