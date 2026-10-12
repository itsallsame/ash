package ai.ash.ui

import android.app.Activity
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import ai.ash.human.ChatBridge
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.Role
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * The chat, drawn natively. It is a page of the [ChatBridge] like the web page was: it speaks the same frames of the human
 * channel (`send`, `sync`, `presence`, `present.result`) and reads the same words (`service:history window/current`,
 * `service:agents list`). The ledger is not mirrored here: a `sync` message only says something changed, and the screen reads
 * the latest window and the current state again (once per burst). Nothing on it moves on its own.
 */
class ChatScreen(private val activity: Activity, private val bridge: ChatBridge, private val onApps: () -> Unit) : ChatBridge.Page {
    private val ctx = activity
    private val c = AshUi.p(ctx)
    private val main = Handler(Looper.getMainLooper())
    private fun dp(v: Int) = AshUi.dp(ctx, v)

    val view = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(c.bg) }
    private val stateLine = AshUi.text(ctx, "", AshType(12f, 16f, 400, Role.TEXT_2))
    private val list = AshUi.vstack(ctx, 8).apply { setPadding(dp(14), dp(8), dp(14), dp(12)) }
    private val scroll = ScrollView(ctx).apply { isFillViewport = true; addView(list) }
    private val pillSlot = FrameLayout(ctx)
    private val input = EditText(ctx)

    private var open = false
    private var primary: String? = null
    private var sid: String? = null
    private val waiting = HashMap<String, (JSONObject) -> Unit>()
    private var refreshQueued = false
    private var lastTyping = 0L
    private var lastShown = ""

    init {
        view.addView(header(), LinearLayout.LayoutParams(-1, dp(56)))
        view.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        view.addView(pillSlot, LinearLayout.LayoutParams(-2, -2).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(6) })
        view.addView(composer(), LinearLayout.LayoutParams(-1, -2))
        render(null, null)
    }

    // --- the bridge ---

    fun start() = bridge.attach(this)
    fun stop() = bridge.detach(this)

    override fun post(message: String) { main.post { receive(message) } }

    private fun receive(message: String) {
        val m = runCatching { JSONObject(message) }.getOrNull() ?: return
        when (m.optString("type")) {
            "link" -> linkChanged(m.optBoolean("open"))
            "frame" -> frame(m.optJSONObject("frame") ?: return)
        }
    }

    private fun linkChanged(nowOpen: Boolean) {
        open = nowOpen
        sid = null
        if (!open) { waiting.clear(); setState("没连上，正在重连…"); return }
        val s = "y_" + UUID.randomUUID()
        sid = s
        out(JSONObject().put("t", "sync").put("ch", "human").put("sid", s).put("limit", 1).put("follow", true).put("summary", true))
        presence(visible = true)
        call("service:agents", "list", JSONObject()) { data ->
            val agents = data.optJSONArray("agents") ?: JSONArray()
            for (i in 0 until agents.length()) agents.optJSONObject(i)?.takeIf { it.optBoolean("primary") }?.let { primary = it.optString("id") }
        }
        refresh()
    }

    private fun frame(f: JSONObject) {
        when (f.optString("t")) {
            "send.result" -> waiting.remove(f.optString("id"))?.invoke(f)
            "sync.page", "sync.msg" -> if (f.optString("sid") == sid) refresh()
            "present" -> out(JSONObject().put("t", "present.result").put("id", f.optString("id")).put("ok", true))
            "error" -> waiting.remove(f.optString("id"))?.invoke(JSONObject().put("ok", false).put("error", JSONObject().put("message", f.optString("message"))))
        }
    }

    private fun out(frame: JSONObject) = Thread { bridge.fromPage(frame) }.start()

    private fun send(request: JSONObject, done: (JSONObject) -> Unit = {}) {
        if (!open) { done(JSONObject().put("ok", false)); return }
        val id = "s_" + UUID.randomUUID()
        waiting[id] = done
        out(JSONObject().put("t", "send").put("ch", "human").put("id", id).put("request", request))
    }

    /** A request to [to] that waits for its answer; [ok] gets the answer's data. */
    private fun call(to: String, word: String, body: JSONObject, ok: (JSONObject) -> Unit) =
        send(JSONObject().put("to", to).put("kind", "request").put("word", word).put("body", body).put("wait", true)) { r ->
            val reply = r.optJSONObject("response")
            if (r.optBoolean("ok") && reply?.optBoolean("ok") == true) ok(reply.optJSONObject("result")?.optJSONObject("data") ?: JSONObject())
        }

    private fun presence(visible: Boolean? = null, typing: Boolean? = null) {
        if (!open) return
        val f = JSONObject().put("t", "presence").put("ch", "human")
        visible?.let { f.put("visible", it) }
        typing?.let { f.put("typing", it); primary?.let { p -> f.put("agent", p) } }
        out(f)
    }

    fun shown(visible: Boolean) { presence(visible = visible); if (visible) refresh() }

    /** Reads the newest window and the current state again; a burst of changes is one read. */
    private fun refresh() {
        if (!open || refreshQueued) return
        refreshQueued = true
        main.postDelayed({
            refreshQueued = false
            var window: JSONObject? = null
            var current: JSONObject? = null
            fun both() { if (window != null && current != null) render(window, current) }
            call("service:history", "window", JSONObject().put("limit", 60)) { window = it; both() }
            call("service:history", "current", JSONObject().put("limit", 60)) { current = it; both() }
        }, 150)
    }

    // --- drawing ---

    private fun header(): View = AshUi.hstack(ctx, 10).apply {
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(14), 0, dp(6), 0)
        addView(OnboardingViews.avatar(ctx, "default", 36), LinearLayout.LayoutParams(dp(36), dp(36)))
        addView(AshUi.vstack(ctx).apply {
            addView(AshUi.text(ctx, "ash", AshType(16f, 20f, 650, Role.INK)))
            addView(stateLine)
        }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(AshUi.button(ctx, "应用", AshUi.Kind.GHOST, AshUi.BtnSize.SM) { onApps() })
    }

    private fun composer(): View = AshUi.hstack(ctx, 8).apply {
        gravity = Gravity.BOTTOM
        setPadding(dp(12), dp(6), dp(12), dp(10))
        input.apply {
            hint = "跟 Ash 说…"
            AshUi.style(this, AshTokens.Type.chat, c.text)
            setHintTextColor(c.text3)
            background = AshUi.rounded(c.surface, AshUi.dpF(ctx, 20f), c.line, dp(1))
            setPadding(dp(14), dp(10), dp(14), dp(10))
            minHeight = dp(44); maxLines = 5
            imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, d: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, d: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    val now = System.currentTimeMillis()
                    if (!s.isNullOrEmpty() && now - lastTyping > 3_000) { lastTyping = now; presence(typing = true) }
                }
            })
        }
        addView(input, LinearLayout.LayoutParams(0, -2, 1f))
        addView(AshUi.button(ctx, "发送", AshUi.Kind.PRIMARY, AshUi.BtnSize.MD) { say(input.text.toString()) })
    }

    private fun say(text: String, option: Pair<String, String>? = null) {
        val target = primary
        if (text.isBlank() || target == null) return
        val body = JSONObject().put("text", text)
        option?.let { body.put("in_reply_to", it.first).put("option_id", it.second) }
        if (option == null) input.setText("")
        send(JSONObject().put("to", target).put("kind", "request").put("word", "say").put("body", body).put("client_id", UUID.randomUUID().toString())) { refresh() }
    }

    private fun answer(ask: JSONObject, choice: String) =
        send(JSONObject().put("to", ask.optString("from")).put("kind", "response").put("word", "ask").put("reply_to", ask.optString("id"))
            .put("body", JSONObject().put("ok", true).put("result", JSONObject().put("data", JSONObject().put("choice", choice))))
            .put("client_id", UUID.randomUUID().toString())) { refresh() }

    private fun setState(s: String) { stateLine.text = s }

    private fun render(window: JSONObject?, current: JSONObject?) {
        val presence = current?.optJSONObject("presence")
        setState(when (presence?.optString("state")) {
            null -> if (open) "" else "正在连接…"
            "thinking" -> "正在想"
            "working" -> presence.optString("text").ifEmpty { "在做事" }
            "waiting_you" -> "等你回复"
            else -> "在线"
        })
        pillSlot.removeAllViews()
        val progress = current?.optJSONObject("progress")
        if (progress != null && !progress.has("ended")) pillSlot.addView(AshUi.progressPill(ctx, "正在处理", progress.optString("title").ifEmpty { "进行中" }, running = false))

        val items = window?.optJSONArray("items") ?: JSONArray()
        val key = "${window?.optLong("snapshot_seq")}:${items.length()}"
        if (key == lastShown && list.childCount > 0) return
        lastShown = key
        val atBottom = !scroll.canScrollVertically(1)
        list.removeAllViews()
        if (items.length() == 0) list.addView(AshUi.text(ctx, if (open) "还没有消息，跟她说点什么吧。" else "正在连接…", AshTokens.Type.body, c.text3).apply { gravity = Gravity.CENTER; setPadding(0, dp(40), 0, 0) })
        for (i in 0 until items.length()) row(items.optJSONObject(i) ?: continue)?.let { list.addView(it) }
        if (atBottom || window != null) scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
    }

    /** One item of the window (the projected conversation of SPEC-05: `say`, `ask`, `card`, `failed`). */
    private fun row(item: JSONObject): View? = when (item.optString("type")) {
        "say" -> bubble(textOf(item), mine = item.optString("side") == "owner")
        "ask" -> item.optJSONObject("ask")?.let { askCard(it) }
        "card" -> showCard(item)
        "failed" -> note("刚才这件事没做成。")
        else -> null
    }

    private fun textOf(item: JSONObject): String {
        val t = item.opt("text")
        val text = if (t is String) t else (t as? JSONObject)?.optString("text").orEmpty()
        val files = item.optJSONArray("attachments")?.length() ?: 0
        return if (files > 0) "$text${if (text.isEmpty()) "" else "\n"}[附件 $files 个]" else text
    }

    private fun bubble(text: String, mine: Boolean): View = FrameLayout(ctx).apply {
        val b = AshUi.bubbleText(ctx, text, mine).apply { setTextIsSelectable(true) }
        addView(b, FrameLayout.LayoutParams(-2, -2, if (mine) Gravity.END else Gravity.START))
    }

    private fun note(text: String): View = AshUi.text(ctx, text, AshType(12.5f, 16f, 400, Role.TEXT_3)).apply { gravity = Gravity.CENTER }

    private fun card(label: String, title: String, body: String): View = AshUi.card(ctx).apply {
        if (label.isNotEmpty()) addView(AshUi.text(ctx, label, AshType(12f, 16f, 600, Role.TEXT_2)))
        if (title.isNotEmpty()) addView(AshUi.text(ctx, title, AshType(15f, 21f, 650, Role.INK)))
        if (body.isNotEmpty()) addView(AshUi.text(ctx, body, AshTokens.Type.body, c.text2))
    }

    private fun askCard(ask: JSONObject): View = AshUi.card(ctx).apply {
        val gate = ask.optString("from") == "service:gate"
        addView(AshUi.text(ctx, if (gate) "需要你确认" else "ash 问你", AshType(12f, 16f, 600, Role.TEXT_2)))
        addView(AshUi.text(ctx, ask.optString("title"), AshType(15f, 21f, 650, Role.INK)))
        ask.optString("detail").takeIf { it.isNotEmpty() }?.let { addView(AshUi.text(ctx, it, AshTokens.Type.body, c.text2)) }
        val options = ask.optJSONArray("options") ?: JSONArray()
        val choice = ask.optString("choice").takeIf { it.isNotEmpty() && it != "null" }
        val pending = ask.optString("state") == "pending" && ask.optLong("expires_at") > System.currentTimeMillis()
        when {
            choice != null -> addView(AshUi.resolved(ctx, labelOf(options, choice, ask.optString("answer_text").ifEmpty { "已回答" })))
            !pending -> addView(AshUi.resolved(ctx, "已结束"))
            else -> for (i in 0 until options.length()) options.optJSONObject(i)?.let { o ->
                addView(AshUi.option(ctx, o.optString("label")) { answer(ask, o.optString("id")) })
            }
        }
    }

    private fun showCard(item: JSONObject): View? {
        val card = item.optJSONObject("card") ?: return null
        val chosen = item.optString("selected_option_id").takeIf { it.isNotEmpty() && it != "null" }
        return when (card.optString("type")) {
            "options" -> AshUi.card(ctx).apply {
                card.optString("prompt").takeIf { it.isNotEmpty() }?.let { addView(AshUi.text(ctx, it, AshType(15f, 21f, 650, Role.INK))) }
                val options = card.optJSONArray("options") ?: JSONArray()
                for (i in 0 until options.length()) options.optJSONObject(i)?.let { o ->
                    val id = o.optString("id")
                    addView(AshUi.option(ctx, o.optString("text"), selected = id == chosen, dimmed = chosen != null && id != chosen,
                        onClick = if (chosen == null) ({ say(o.optString("text"), item.optString("id") to id) }) else null))
                }
            }
            "link" -> card("链接", card.optString("title"), listOf(card.optString("summary"), card.optString("url")).filter { it.isNotEmpty() }.joinToString("\n"))
            "file" -> card("文件", card.optString("name"), "")
            "image" -> card("图片", card.optString("alt"), "")
            "permission" -> card("需要权限", card.optString("permission"), card.optString("why"))
            "app" -> card(card.optString("name"), card.optString("title"), card.optString("text"))
            else -> null
        }
    }

    private fun labelOf(options: JSONArray, id: String, fallback: String): String {
        for (i in 0 until options.length()) options.optJSONObject(i)?.let { if (it.optString("id") == id) return it.optString("label") }
        return fallback
    }

    /** Puts the cursor in the message box and raises the keyboard. */
    fun focusInput() {
        input.requestFocus()
        ctx.getSystemService(InputMethodManager::class.java)?.showSoftInput(input, 0)
    }
}
