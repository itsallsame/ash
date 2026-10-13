package ai.ash.ui

import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.AshUi.Kind
import ai.ash.ui.design.Role
import org.json.JSONObject

/** 接下来: a week strip, and the plans of the chosen day by time. A plan is removed only after the clock confirmed its cancel. */
class HmUpcoming(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "接下来"
    private var timers: List<HomeModel.Timer>? = null
    private var failed = false
    private var day = HomeModel.startOfDay(System.currentTimeMillis())
    private var armed: String? = null
    private var error = ""

    init { draw() }

    override fun refresh() = call("service:clock", "list") { r ->
        val list = if (r.ok) HomeModel.normalizeClock(r.data) else null
        failed = list == null
        if (list != null) timers = HomeModel.userPlans(list)
        draw()
    }

    private fun draw(): Unit = redraw {
        val list = timers
        if (failed && list == null) {
            addView(AshUi.vstack(ctx, 10).apply { addView(Hk.note(ctx, "暂时读不到计划（不代表没有）。", "warn")); addView(AshUi.button(ctx, "重试", Kind.NEUTRAL, AshUi.BtnSize.SM) { refresh() }) })
            return@redraw
        }
        if (list == null) { addView(Hk.note(ctx, "正在读取…")); return@redraw }
        val now = System.currentTimeMillis()
        addView(AshUi.hstack(ctx, 4).apply {
            gravity = Gravity.TOP
            HomeModel.weekStrip(list, now).forEach { d ->
                val on = d.day == day
                addView(AshUi.vstack(ctx, 4).apply {
                    gravity = Gravity.CENTER_HORIZONTAL; setPadding(0, dp(8), 0, dp(8)); isClickable = true
                    background = if (on) AshUi.rounded(c.you, AshUi.dpF(ctx, 16f)) else null
                    setOnClickListener { day = d.day; armed = null; draw() }
                    addView(AshUi.text(ctx, HomeModel.weekdayShort(d.day), AshType(11.5f, 16f, 400, null), if (on) c.onYou else c.text3))
                    addView(AshUi.text(ctx, HomeModel.dayOfMonth(d.day).toString(), AshType(17f, 24f, 650, null), if (on) c.onYou else c.ink))
                    addView(View(ctx).apply { background = AshUi.rounded(if (d.count > 0) (if (on) c.onYou else c.you) else 0, AshUi.dpF(ctx, 3f)) }, LinearLayout.LayoutParams(dp(5), dp(5)))
                }, LinearLayout.LayoutParams(0, -2, 1f))
            }
        })
        if (list.isEmpty()) { addView(Hk.list(ctx, listOf(Hk.row(ctx, "clock", "暂无计划", "她答应到点做的事、提醒你的事，会出现在这里。")))); return@redraw }
        val startToday = HomeModel.startOfDay(now)
        val label = "${if (day == startToday) "今天" else if (day == startToday + HomeModel.DAY) "明天" else HomeModel.weekday(day)} · ${HomeModel.clock(day).substringBefore(' ')}"
        val rows = HomeModel.dayItems(list, day).map { (at, timer) -> plan(at, timer, now) }
        addView(AshUi.group(ctx, label, rows = if (rows.isEmpty()) listOf(Hk.row(ctx, "clock", "这一天没有计划")) else rows, iconInset = false))
    }

    private fun plan(at: Long, timer: HomeModel.Timer, now: Long): View {
        val key = "${timer.id}:$at"
        val isArmed = armed == key
        val title = timer.label.ifEmpty { "没有名字的计划" }
        return AshUi.vstack(ctx).apply {
            minimumHeight = dp(64)
            addView(AshUi.hstack(ctx, 12).apply {
                setPadding(dp(14), dp(8), dp(14), dp(8)); minimumHeight = dp(64)
                addView(AshUi.text(ctx, HomeModel.hhmm(at), AshType(22f, 28f, 700, Role.INK)), LinearLayout.LayoutParams(dp(62), -2))
                addView(AshUi.vstack(ctx, 1).apply {
                    addView(AshUi.text(ctx, title, AshTokens.Type.listTitle))
                    addView(AshUi.hstack(ctx, 4).apply { if (timer.every != null) addView(Hk.tint(ctx, "repeat", c.text2, 12)); addView(AshUi.text(ctx, HomeModel.repeatText(timer.every), AshTokens.Type.listSub)) })
                    if (timer.blocked) addView(AshUi.text(ctx, "暂时没法执行：请稍后再看", AshTokens.Type.listSub, c.warn))
                }, LinearLayout.LayoutParams(0, -2, 1f))
                if (isArmed) addView(AshUi.button(ctx, "确认删除", Kind.DANGER, AshUi.BtnSize.SM) { remove(timer) })
                else addView(AshUi.iconButton(ctx, Hk.icon(ctx, "trash").apply { setTint(c.text3) }, "删除") { armed = key; error = ""; draw() })
            })
            if (isArmed) addView(AshUi.text(ctx, if (timer.every != null) "删除后，「$title」以后都不会再有了。" else "删除后，${HomeModel.dayTime(at, now)}的「$title」就取消了。", AshTokens.Type.caption, c.err).apply { setPadding(dp(88), 0, dp(14), dp(10)) })
            if (isArmed && error.isNotEmpty()) addView(AshUi.text(ctx, error, AshTokens.Type.caption, c.err).apply { setPadding(dp(88), 0, dp(14), dp(10)) })
        }
    }

    private fun remove(timer: HomeModel.Timer) {
        val key = "clock.cancel:${timer.id}"
        call("service:clock", "cancel", JSONObject().put("id", timer.id), env.intents.id(key)) { r ->
            if (!r.ok || !r.data.optBoolean("cancelled")) {
                error = if (r.code == "forbidden") "这台设备不能修改计划。" else if (r.ok || !r.retryable) "没有收到确认，可以再试一次。" else "还没确认结果；再点一次会原样重试。"
                if (r.ok || !r.retryable) env.intents.drop(key)
                draw(); return@call
            }
            call("service:clock", "list") { l ->
                val fresh = if (l.ok) HomeModel.normalizeClock(l.data)?.let { HomeModel.userPlans(it) } else null
                if (fresh == null) { error = "没有收到确认，可以再试一次。"; draw(); return@call }
                if (fresh.any { it.id == timer.id }) { error = "删除后它还在列表里；请稍后再看。"; timers = fresh; draw(); return@call }
                env.intents.drop(key); timers = fresh; armed = null; error = ""; draw()
            }
        }
    }
}
