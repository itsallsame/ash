package ai.ash.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.AshUi.Kind
import ai.ash.ui.design.AshUi.Tone
import ai.ash.ui.design.Role
import org.json.JSONObject
import kotlin.math.max

/** The last seven days' cost as bars: still, drawn once. */
class SpendBars(ctx: Context, private val heights: List<Float>) : View(ctx) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val c = AshUi.p(ctx)
    override fun onMeasure(w: Int, h: Int) = setMeasuredDimension(AshUi.dp(context, heights.size * 14), AshUi.dp(context, 52))
    override fun onDraw(canvas: Canvas) {
        val bw = AshUi.dpF(context, 9f); val gap = AshUi.dpF(context, 5f); val r = AshUi.dpF(context, 3f)
        heights.forEachIndexed { i, f ->
            paint.color = if (i == heights.size - 1) c.youMark else c.surface3
            val top = height - maxOf(AshUi.dpF(context, 6f), f * height)
            canvas.drawRoundRect(RectF(i * (bw + gap), top, i * (bw + gap) + bw, height.toFloat()), r, r, paint)
        }
    }
}

private fun spendCard(ctx: Context, usage: JSONObject?, balance: JSONObject?, onClick: (() -> Unit)?): View {
    val week = usage?.optJSONObject("periods")?.optJSONObject("7d")?.dbl("cost_usd")
    val days = usage?.list("by_day")?.takeLast(7)?.map { it.dbl("cost_usd") ?: 0.0 } ?: emptyList()
    val peak = max(days.maxOrNull() ?: 0.0, 0.000001)
    var balanceLine = ""
    for (e in balance?.list("balances") ?: emptyList()) {
        val b = e.optJSONObject("balance") ?: continue
        val item = b.list("balances").firstOrNull()
        if (item != null && b.opt("available") != false) { balanceLine = " · 余额 ${HomeModel.balanceText(item)}"; break }
    }
    return AshUi.card(ctx).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.BOTTOM
        setPadding(AshUi.dp(ctx, 16), AshUi.dp(ctx, 16), AshUi.dp(ctx, 16), AshUi.dp(ctx, 16))
        addView(AshUi.vstack(ctx).apply {
            addView(AshUi.text(ctx, "近 7 天花了", AshTokens.Type.caption))
            addView(AshUi.text(ctx, HomeModel.usdToCny(week), AshType(28f, 36f, 700, Role.INK)))
            addView(AshUi.text(ctx, "今天 ${HomeModel.usdToCny(usage?.optJSONObject("periods")?.optJSONObject("today")?.dbl("cost_usd"))}$balanceLine", AshTokens.Type.caption))
        }, LinearLayout.LayoutParams(0, -2, 1f))
        if (days.isNotEmpty()) addView(SpendBars(ctx, days.map { (it / peak).toFloat() }))
        onClick?.let { f -> isClickable = true; setOnClickListener { f() } }
    }
}

/** 幕后: what runs her. Keys (and whether they work), the model, what she costs, and the developer options. */
class HmBackstage(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "幕后"
    private var usage: JSONObject? = null
    private var balance: JSONObject? = null
    private var vault: List<JSONObject>? = null
    private var health: List<JSONObject> = emptyList()
    private var agents: List<JSONObject>? = null
    private val pause = HomePause(env, ctx, Kind.DANGER) { word, b, id, done -> call("service:admin", word, b, id, done) }

    init { draw() }

    private fun draw() {
        body.removeAllViews()
        body.addView(spendCard(ctx, usage, balance) { env.nav.go("usage") })
        fun saved(ref: String) = vault?.any { it.str("ref") == ref && it.optBoolean("configured") } == true
        val rows = HomeModel.KEYS.map { k ->
            val h = health.firstOrNull { it.str("provider") == k.provider }
            val bad = saved(k.ref) && (h?.str("status") == "rejected" || h?.str("status") == "low_balance")
            Hk.row(ctx, "key", k.title, k.use, trailing = vault?.let {
                AshUi.tag(ctx, if (bad) (if (h?.str("status") == "rejected") "已失效" else "余额不足") else if (saved(k.ref)) "已保存" else "还没保存", if (bad || !saved(k.ref)) Tone.WARN else Tone.OK)
            }) { env.nav.go("keys") }
        }
        val model = agents?.firstOrNull { it.optBoolean("primary") }?.optJSONObject("runtime")?.str("model")
        body.addView(AshUi.group(ctx, "让她能说话", rows = rows + Hk.row(ctx, "cpu", "模型", trailing = AshUi.hstack(ctx, 6).apply { addView(Hk.value(ctx, if (model != null) HomeModel.providerName(model) else if (saved("DEEPSEEK_API_KEY")) "DeepSeek" else "")); addView(Hk.chev(ctx)) }, chev = false) { env.nav.go("model") }))
        body.addView(AshUi.group(ctx, "高级", rows = listOf(Hk.row(ctx, "slider", "开发者选项", "主模型、插件") { env.nav.go("advanced") })))
        body.addView(pause.root)
    }

    override fun refresh() {
        call("service:cost", "usage.get", JSONObject().put("days", 7)) { r -> if (r.ok) { usage = r.data; draw() } }
        call("service:cost", "balance.get") { r -> if (r.ok) { balance = r.data; draw() } }
        call("service:vault", "list") { r -> if (r.ok) { vault = r.data.list("entries"); draw() } }
        call("service:llm", "keys.status") { r -> if (r.ok) { health = r.data.list("keys"); draw() } }
        call("service:agents", "list") { r -> if (r.ok) { agents = r.data.list("agents").filter { it.str("id") != null }; draw() } }
        pause.read()
    }
}

/** 花了多少: today, seven days and thirty days, and where the last week went. */
class HmUsage(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "花了多少"
    private var usage: JSONObject? = null
    private var balance: JSONObject? = null
    private var balanceRead = false
    private var agents: List<JSONObject> = emptyList()
    private var status = "正在读取…"

    init { draw() }

    private fun line(title: String, t: JSONObject?): View {
        val calls = t?.num("calls") ?: 0
        val unpriced = t?.num("unpriced_calls") ?: 0
        return AshUi.row(ctx, title, "$calls 次调用 · 输入 ${HomeModel.tokens(t?.dbl("input_tokens") ?: 0.0)} / 输出 ${HomeModel.tokens(t?.dbl("output_tokens") ?: 0.0)}${if (unpriced > 0) " · 另有 $unpriced 次没有价格" else ""}",
            null, trailing = Hk.value(ctx, HomeModel.usdToCny(t?.dbl("cost_usd") ?: 0.0)))
    }

    private fun draw(): Unit = redraw {
        val u = usage
        if (u == null) { addView(Hk.note(ctx, status, if (status.contains("失败")) "warn" else null)); addView(AshUi.button(ctx, "重试", Kind.NEUTRAL, AshUi.BtnSize.SM) { refresh() }); return@redraw }
        val p = u.optJSONObject("periods")
        addView(spendCard(ctx, u, balance, null))
        addView(AshUi.group(ctx, rows = listOf(line("今天", p?.optJSONObject("today")), line("近 7 天", p?.optJSONObject("7d")), line("近 30 天", p?.optJSONObject("30d"))), iconInset = false))
        val names = agents.associate { (it.str("id") ?: "") to (it.str("name") ?: "") }
        val callers = u.list("by_caller").filter { it.str("caller") != null }
        if (callers.isNotEmpty()) addView(AshUi.group(ctx, "近 7 天花在哪", rows = callers.map { e ->
            val caller = e.str("caller")!!
            line(names[caller]?.ifEmpty { null } ?: if (caller == "service:reflex") "快速判断" else if (caller.startsWith("service:")) "后台服务" else HomeModel.HELPER, e)
        }, iconInset = false))
        if (balanceRead) addView(Hk.note(ctx, if (balance == null) "账户余额暂时读不到（不是零）。" else HomeModel.balanceSentence(balance)))
        addView(Hk.note(ctx, "${if (u.optBoolean("estimated")) "费用按模型的公开价格估算。" else ""}${HomeModel.CNY_NOTE}"))
        addView(AshUi.button(ctx, "刷新", Kind.NEUTRAL, block = true) { refresh() })
    }

    override fun refresh() {
        status = "正在读取…"
        call("service:cost", "usage.get", JSONObject().put("days", 7)) { r ->
            if (!r.ok) { usage = null; status = "用量读取失败，请重试。"; draw(); return@call }
            usage = r.data; draw()
            call("service:cost", "balance.get") { b -> balance = if (b.ok) b.data else null; balanceRead = true; draw() }
            call("service:agents", "list") { a -> if (a.ok) { agents = a.data.list("agents"); draw() } }
        }
    }
}

/** Keys: saved on this phone; the page learns whether one is saved and works, never what it is. */
class HmKeys(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "密钥"
    private var vault: List<JSONObject>? = null
    private var locked = false
    private var health: List<JSONObject> = emptyList()
    private val checking = HashSet<String>()
    private val status = HashMap<String, String>()
    private val fields = HomeModel.KEYS.associate { it.ref to Hk.field(ctx, "粘贴 Key", password = true) }

    init { draw() }

    private fun saved(ref: String) = vault?.any { it.str("ref") == ref && it.optBoolean("configured") } == true
    private fun standing(provider: String) = health.firstOrNull { it.str("provider") == provider }

    private fun verify(k: HomeModel.KeyInfo) {
        checking.add(k.ref); draw()
        call("service:llm", "keys.check", JSONObject().put("provider", k.provider)) { r ->
            if (r.ok) health = r.data.list("keys")
            else health = health.filter { it.str("provider") != k.provider } + JSONObject().put("provider", k.provider).put("ref", k.ref).put("configured", true).put("status", "unknown").put("reason", "没能问到服务商")
            checking.remove(k.ref); draw()
        }
    }

    private fun failure(k: HomeModel.KeyInfo, r: Reply, text: String) { if (r.code == "unavailable") locked = true else status[k.ref] = text; draw() }

    private fun statusText(k: HomeModel.KeyInfo): Pair<String, String?> {
        val h = standing(k.provider)
        status[k.ref]?.takeIf { it.isNotEmpty() }?.let { return it to null }
        return when {
            locked -> "手机安全存储暂时不可用。原有密钥未被读取或修改，请重启手机后再试。" to "warn"
            vault == null -> "正在读取…" to null
            !saved(k.ref) -> "还没有保存。${k.hint}" to "warn"
            k.ref in checking -> "已保存，正在验证…" to null
            else -> HomeModel.keyStateText(h) to (if (h?.str("status") == "rejected" || h?.str("status") == "low_balance") "warn" else if (h?.str("status") == "ok") "ok" else null)
        }
    }

    private fun draw(): Unit = redraw {
        addView(Hk.note(ctx, "Key 只保存在这台手机上。她知道存了哪几个，但看不到内容，Key 也不会出现在聊天里。保存后立刻生效。"))
        val found = HomeModel.keyProblems(health)
        if (found.isNotEmpty()) addView(Hk.pre(ctx, (listOf("发现这些问题：") + found.map { "· $it" }).joinToString("\n")))
        HomeModel.KEYS.forEach { k ->
            val field = fields.getValue(k.ref)
            (field.parent as? android.view.ViewGroup)?.removeView(field)
            field.hint = if (saved(k.ref)) "粘贴新的 Key 替换" else "粘贴 Key"
            field.isEnabled = !locked
            val (text, tone) = statusText(k)
            addView(AshUi.card(ctx).apply {
                setPadding(dp(16), dp(16), dp(16), dp(16))
                addView(AshUi.text(ctx, k.title, AshType(20f, 28f, 700, Role.INK)))
                addView(AshUi.text(ctx, "用于：${k.use}", AshTokens.Type.sub))
                addView(AshUi.text(ctx, text, AshType(13f, 19f, 400, Role.TEXT_2), tone?.let { Hk.strong(c, it) }))
                addView(field)
                addView(AshUi.hstack(ctx, 8).apply {
                    addView(AshUi.button(ctx, "保存", Kind.PRIMARY, AshUi.BtnSize.SM) { save(k, field) }.also { if (locked) AshUi.disable(it) })
                    if (saved(k.ref) && !locked) {
                        addView(AshUi.button(ctx, "验证", Kind.NEUTRAL, AshUi.BtnSize.SM) { verify(k) })
                        addView(Hk.twoTap(ctx, "移除", "确定移除？", "移除后，${k.hint.removePrefix("没有它，")}", { status[k.ref] = it; draw() }, AshUi.BtnSize.SM, false) { remove(k) })
                    }
                })
            })
        }
    }

    private fun save(k: HomeModel.KeyInfo, field: EditText) {
        val value = field.text.toString().trim()
        field.setText("")
        if (value.isEmpty()) { status[k.ref] = "请先粘贴 Key。"; draw(); return }
        status[k.ref] = "正在保存…"; draw()
        call("service:vault", "set", JSONObject().put("ref", k.ref).put("value", value).put("label", k.title).put("kind", "model")) { r ->
            if (r.ok && r.data.optBoolean("configured")) {
                vault = (vault ?: emptyList()).filter { it.str("ref") != k.ref } + JSONObject().put("ref", k.ref).put("configured", true)
                health = health.filter { it.str("provider") != k.provider }; status[k.ref] = ""; verify(k)
            } else if (r.ok) { status[k.ref] = "保存失败，请重试。"; draw() } else failure(k, r, "保存失败，请重试。")
        }
    }

    private fun remove(k: HomeModel.KeyInfo) = call("service:vault", "delete", JSONObject().put("ref", k.ref)) { r ->
        if (r.ok && r.data.optBoolean("deleted")) {
            vault = (vault ?: emptyList()).map { if (it.str("ref") == k.ref) JSONObject(it.toString()).put("configured", false) else it }
            health = health.filter { it.str("provider") != k.provider }; status[k.ref] = ""; draw()
        } else if (r.ok) { status[k.ref] = "移除失败，请重试。"; draw() } else failure(k, r, "移除失败，请重试。")
    }

    override fun refresh() {
        call("service:vault", "list") { v ->
            call("service:llm", "keys.status") { s ->
                if (!v.ok && v.code != "unavailable") { HomeModel.KEYS.forEach { status[it.ref] = "读取失败，请重试。" }; draw(); return@call }
                locked = !v.ok; vault = if (v.ok) v.data.list("entries") else emptyList(); health = if (s.ok) s.data.list("keys") else emptyList(); draw()
                for (k in HomeModel.KEYS) { val h = health.firstOrNull { it.str("ref") == k.ref }; if (saved(k.ref) && h?.optBoolean("configured") == true && h.str("status") == "unknown" && !h.has("checked_at")) verify(k) }
            }
        }
    }
}

/** The main model: what she runs now, and a place to change it. */
class HmModel(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "模型"
    private val provider = Hk.field(ctx, "Provider（比如 deepseek）")
    private val model = Hk.field(ctx, "Model")
    private val status = Hk.note(ctx, "")
    private val save = AshUi.button(ctx, "保存模型", Kind.PRIMARY, block = true) { save() }

    init {
        body.addView(Hk.note(ctx, "她现在用的主模型。改错了可能让她无法正常工作。"))
        body.addView(AshUi.card(ctx).apply { setPadding(dp(16), dp(16), dp(16), dp(16)); addView(provider); addView(model) })
        body.addView(save); body.addView(status)
    }

    private fun enable(on: Boolean) { listOf(provider, model).forEach { it.isEnabled = on }; save.isEnabled = on; save.alpha = if (on) 1f else 0.4f }

    private fun save() {
        val p = provider.text.toString().trim(); val m = model.text.toString().trim()
        if (p.isEmpty() || m.isEmpty()) { status.text = "Provider 和 Model 都要填。"; return }
        status.text = "正在保存…"
        call("service:admin", "model.set", JSONObject().put("provider", p).put("model", m)) { r ->
            status.text = if (r.ok && r.data.str("provider") == p && r.data.str("model") == m && r.data.has("restart_required")) (if (r.data.optBoolean("restart_required")) "已保存；重启后主模型生效。" else "已保存，下一条消息起就用它。") else "保存未确认，请重试。"
        }
    }

    override fun refresh() {
        status.text = "正在读取…"; enable(false)
        call("service:agents", "list") { r ->
            enable(true)
            if (!r.ok) { status.text = "读取失败，请返回后重试。"; return@call }
            val m = r.data.list("agents").firstOrNull { it.optBoolean("primary") }?.optJSONObject("runtime")?.str("model") ?: ""
            model.setText(m)
            status.text = if (m.isNotEmpty()) "" else "没有读到现在用的模型，请直接填写。"
        }
    }
}

/** 开发者选项: the main model and the extensions (plugins) she runs with. */
class HmAdvanced(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "开发者选项"
    private val status = Hk.note(ctx, "")
    private val listBox = AshUi.vstack(ctx)

    init {
        body.addView(Hk.note(ctx, "给开发和排查问题用。改错了可能让她无法正常工作。"))
        body.addView(AshUi.group(ctx, rows = listOf(Hk.row(ctx, "cpu", "主模型") { env.nav.go("model") })))
        body.addView(AshUi.vstack(ctx, 8).apply { addView(AshUi.text(ctx, "她的扩展", AshTokens.Type.sub).apply { setPadding(dp(6), 0, dp(6), 0) }); addView(listBox) })
        body.addView(status)
    }

    private fun read(done: () -> Unit = {}) {
        status.text = "正在读取…"
        call("service:admin", "plugins.list") { r ->
            val plugins = if (r.ok) r.data.list("plugins") else null
            if (plugins == null) { status.text = "插件读取失败，请重试。"; return@call }
            listBox.removeAllViews()
            val rows = plugins.mapNotNull { p ->
                val entry = p.str("entryId") ?: p.str("id") ?: return@mapNotNull null
                val name = p.str("moduleName") ?: p.str("name") ?: return@mapNotNull null
                val sw = AshUi.AshSwitch(ctx).apply {
                    set(p.optBoolean("enabled"))
                    if (p.str("readOnlyReason") != null) { isEnabled = false; alpha = 0.4f }
                }
                sw.onChange = { next ->
                    status.text = "正在保存…"
                    call("service:admin", "plugins.op", JSONObject().put("op", "plugin").put("id", entry).put("enabled", next)) { o ->
                        val app = o.data.str("application")
                        if (o.ok && (app == null || app in listOf("applied", "restart-required"))) read { status.text = if (app == "restart-required") "已保存；重启后生效。" else "已更新插件。" }
                        else { status.text = "插件更新未确认，请重试。"; sw.set(!next) }
                    }
                }
                AshUi.row(ctx, HomeModel.pluginName(name), if (p.optBoolean("enabled")) "已启用" else "已停用", null, trailing = sw)
            }
            listBox.addView(AshUi.group(ctx, rows = rows.ifEmpty { listOf(AshUi.row(ctx, "没有安装插件")) }, iconInset = false))
            status.text = "已安装 ${plugins.size} 个插件。"
            done()
        }
    }

    override fun refresh() = read()
}
