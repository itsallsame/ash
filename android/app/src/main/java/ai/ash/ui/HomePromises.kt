package ai.ash.ui

import android.app.TimePickerDialog
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.AshUi.Kind
import ai.ash.ui.design.Role
import org.json.JSONArray
import org.json.JSONObject

/** 你们的约定: the quiet hours, how often she asks before acting (and what you said 「always」 to), and when she may come to you. */
class HmPromises(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "你们的约定"
    private var quiet: String? = null
    private var quietStatus = ""
    private var mode: String? = null
    private var modeStatus = ""
    private var rules: List<JSONObject>? = null
    private var armed: String? = null
    private var ruleStatus = ""
    private var proactive: String? = null
    private val quietBox = AshUi.vstack(ctx)
    private val modeBox = AshUi.vstack(ctx)
    private val proactiveBox = AshUi.vstack(ctx)
    private val editorHost = AshUi.vstack(ctx)
    private var editor: DocEditor? = null
    private var wantEdit = arg == "proactive"

    private val modes = listOf(
        Triple("auto", "有影响时才问", "对外发消息、删改你的数据、花钱、执行命令之前先问你；看、找、打开这类能撤回的事，她直接做。"),
        Triple("always", "每次都问", "除了看和读，外部操作都先问你；单独设为「完全放开」的电脑除外。"))

    init {
        body.addView(quietBox); body.addView(modeBox); body.addView(proactiveBox)
        drawQuiet(); drawMode(); drawProactive()
    }

    private fun promiseCard(icon: String, title: String, vararg trailing: View): LinearLayout = AshUi.card(ctx).apply {
        setPadding(dp(16), dp(16), dp(16), dp(16))
        addView(AshUi.hstack(ctx, 8).apply {
            addView(Hk.tint(ctx, icon, c.text2, AshTokens.Size.iconSm))
            addView(AshUi.text(ctx, title, AshTokens.Type.sub), LinearLayout.LayoutParams(0, -2, 1f))
            trailing.forEach { addView(it) }
        })
    }

    // ---- quiet hours
    private fun saveQuiet(value: String) {
        quietStatus = "正在保存…"; drawQuiet()
        if (value.isNotEmpty() && !HomeModel.QUIET_FORMAT.matches(value)) { quietStatus = "保存未确认，请重试。"; drawQuiet(); return }
        call("service:admin", "settings.set", JSONObject().put(HomeModel.QUIET_KEY, value)) { r ->
            if (r.ok && r.data.opt(HomeModel.QUIET_KEY) == value) { quiet = value; quietStatus = if (value.isNotEmpty()) "已保存免打扰时段。" else "已关闭免打扰。" }
            else quietStatus = "保存未确认，请重试。"
            drawQuiet()
        }
    }

    private fun pill(value: String, onPick: (String) -> Unit): TextView = AshUi.text(ctx, value, AshType(18f, 26f, 650, null), c.youText).apply {
        background = AshUi.rounded(c.youSoft, AshUi.dpF(ctx, 10f)); setPadding(dp(10), dp(2), dp(10), dp(2)); minHeight = dp(AshTokens.Size.touch - 12)
        gravity = Gravity.CENTER_VERTICAL; isClickable = true
        setOnClickListener {
            val (h, m) = value.split(":").let { it[0].toInt() to it[1].toInt() }
            TimePickerDialog(ctx, { _, hh, mm -> onPick("%02d:%02d".format(hh, mm)) }, h, m, true).show()
        }
    }

    private fun drawQuiet() {
        quietBox.removeAllViews()
        val q = quiet
        val sentence: View = when {
            q == null -> AshUi.text(ctx, "正在读取…", AshType(18f, 30f, 400, Role.INK))
            q.isEmpty() -> AshUi.text(ctx, "没有设置免打扰，她随时可能找你。", AshType(18f, 30f, 400, Role.INK))
            else -> {
                val from = q.substringBefore("-"); val to = q.substringAfter("-")
                val t = { s: String -> AshUi.text(ctx, s, AshType(18f, 30f, 400, Role.INK)) }
                Flow(ctx, 0, 0).apply { addView(t("每天 ")); addView(pill(from) { saveQuiet("$it-$to") }); addView(t(" 到 ")); addView(pill(to) { saveQuiet("$from-$it") }); addView(t("，她不主动找你。")) }
            }
        }
        quietBox.addView(promiseCard("moon", "免打扰").apply {
            addView(sentence)
            addView(AshUi.text(ctx, "这段时间里她想主动说的事先攒着，到点再说；你找她、你定的提醒，照常送达。", AshTokens.Type.caption))
            if (q != null) addView(if (q.isNotEmpty()) AshUi.button(ctx, "不设免打扰", Kind.GHOST, AshUi.BtnSize.SM) { saveQuiet("") } else AshUi.button(ctx, "设置免打扰", Kind.SECONDARY, AshUi.BtnSize.SM) { saveQuiet(HomeModel.QUIET_DEFAULT) })
            if (quietStatus.isNotEmpty()) addView(Hk.note(ctx, quietStatus))
        })
    }

    // ---- approval
    private fun saveMode(m: String) {
        modeStatus = "正在保存…"; drawMode()
        call("service:gate", "mode.set", JSONObject().put("mode", m)) { r ->
            if (r.ok && r.data.str("mode") == m) { mode = m; modeStatus = "已保存。" } else modeStatus = "保存未确认，请重试。"
            drawMode()
        }
    }

    private fun readRules() = call("service:gate", "rules.list", JSONObject().put("limit", 100)) { r ->
        if (r.ok) {
            val now = System.currentTimeMillis()
            mode = r.data.str("mode")?.takeIf { it == "always" || it == "auto" }
            rules = r.data.list("rules").filter { it.str("id") != null && it.num("revoked_at") == null && (it.num("expires_at") ?: 0) > now }
            drawMode()
        }
    }

    private fun revoke(rule: JSONObject) {
        val id = rule.str("id") ?: return
        val key = "rule.revoke:$id"
        call("service:gate", "rules.revoke", JSONObject().put("id", id), env.intents.id(key)) { r ->
            if (r.ok && r.data.optBoolean("revoked")) { env.intents.drop(key); armed = null; ruleStatus = ""; readRules() }
            else { ruleStatus = "还没确认撤销成功；再点一次「确认撤销」会原样重试。"; if (r.ok || !r.retryable) env.intents.drop(key); drawMode() }
        }
    }

    private fun ruleLabel(rule: JSONObject): String {
        val obj = rule.str("object_pattern")?.takeIf { it != "*" }?.take(80) ?: ""
        return when {
            rule.str("word") == "calendar.create" && obj.isNotEmpty() -> "在「$obj」日历里建日程"
            rule.str("word") == "message.send" && obj.isNotEmpty() -> "给「$obj」发消息"
            else -> HomeModel.actionLabel(rule.str("word"), rule.str("risk")) + if (obj.isNotEmpty()) " · $obj" else ""
        }
    }

    private fun drawMode() {
        modeBox.removeAllViews()
        val now = System.currentTimeMillis()
        val current = modes.firstOrNull { it.first == mode }
        modeBox.addView(promiseCard("shield", "什么时候先问你").apply {
            addView(AshUi.segmented(ctx, modes.map { it.second }, modes.indexOfFirst { it.first == mode }.coerceAtLeast(0)) { i -> if (mode != null && mode != modes[i].first) saveMode(modes[i].first) })
            current?.let { addView(AshUi.text(ctx, it.third, AshTokens.Type.sub)) }
            addView(Hk.divider(ctx))
            addView(AshUi.text(ctx, "你说过以后都可以的", AshTokens.Type.caption))
            val list = rules
            if (list == null) addView(AshUi.text(ctx, "正在读取…", AshTokens.Type.caption))
            else if (list.isEmpty()) addView(AshUi.text(ctx, "还没有。你点「以后都允许」的事会记在这里。", AshTokens.Type.caption))
            else list.forEach { rule ->
                val isArmed = armed == rule.str("id")
                addView(AshUi.hstack(ctx, 8).apply {
                    minimumHeight = dp(44)
                    addView(AshUi.vstack(ctx).apply {
                        addView(AshUi.text(ctx, ruleLabel(rule), AshType(14.5f, 20f, 400, Role.TEXT)))
                        addView(AshUi.text(ctx, "${HomeModel.dayTime(rule.num("expires_at") ?: 0, now)} 前有效", AshTokens.Type.caption))
                        if (isArmed) addView(AshUi.text(ctx, "撤销后，她下次做这件事前会先问你。", AshTokens.Type.caption, c.err))
                    }, LinearLayout.LayoutParams(0, -2, 1f))
                    addView(AshPageSmall(if (isArmed) "确认撤销" else "撤销", if (isArmed) Kind.DANGER else Kind.GHOST) { if (!isArmed) { armed = rule.str("id"); drawMode() } else revoke(rule) })
                })
            }
            if (ruleStatus.isNotEmpty()) addView(Hk.note(ctx, ruleStatus, "warn"))
            if (modeStatus.isNotEmpty()) addView(Hk.note(ctx, modeStatus))
        })
    }

    private fun AshPageSmall(label: String, kind: Kind, onClick: () -> Unit) = ai.ash.ui.design.AshPage.smallButton(ctx, label, kind, onClick)

    // ---- proactive contact
    private fun drawProactive() {
        proactiveBox.removeAllViews()
        val text = proactive
        val pen = AshUi.iconButton(ctx, Hk.icon(ctx, "pen"), if (editor?.editing == true) "收起" else "改这一条") { toggleEdit() }
        proactiveBox.addView(promiseCard("bell", "什么事可以直接找你", pen).apply {
            addView(
                if (text == null) AshUi.text(ctx, "正在读取…", AshType(18f, 30f, 400, Role.INK))
                else if (text.isNotBlank()) AshUi.text(ctx, text.trim(), AshType(15f, 24f, 400, Role.TEXT))
                else AshUi.text(ctx, "关于你的偏好，还没写。", AshType(15f, 24f, 400, Role.TEXT_3)))
            (editorHost.parent as? android.view.ViewGroup)?.removeView(editorHost)
            editorHost.visibility = if (editor?.editing == true) View.VISIBLE else View.GONE
            addView(editorHost)
        })
    }

    private fun toggleEdit() {
        val e = editor ?: return
        if (e.editing) e.cancelEdit() else e.edit()
        drawProactive()
    }

    override fun refresh() {
        call("service:admin", "settings.get", JSONObject().put("keys", JSONArray().put(HomeModel.QUIET_KEY))) { r -> if (r.ok) HomeModel.quietOf(r.data.optJSONObject("settings"))?.let { quiet = it; drawQuiet() } }
        readRules()
        if (editor == null) {
            val ed = DocEditor(this, WorkspaceStore("PROACTIVE.md") { to, word, b, id, done -> call(to, word, b, id, done) }, { View(ctx).apply { visibility = View.GONE } }, {}) { x -> if (x.loaded) proactive = x.content; if (alive) drawProactive() }
            editor = ed
            editorHost.addView(ed.root)
            ed.load { if (alive) { proactive = ed.content; if (wantEdit) { wantEdit = false; ed.edit() }; drawProactive() } }
        } else if (editor?.editing != true && editor?.busy != true) editor?.load { if (alive) { proactive = editor?.content; drawProactive() } }
    }

    override fun onDispose() { editor?.dispose() }
}
