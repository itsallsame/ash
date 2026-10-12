package ai.ash.ui

import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.AshUi.Kind
import ai.ash.ui.design.Role
import org.json.JSONObject
import java.util.UUID

/** How a managed file is read and written: USER.md and MEMORY.md are plain files of her work folder, SOUL.md and IDENTITY.md belong to the persona member. */
interface DocStore {
    class Read(val ok: Boolean, val content: String?, val truncated: Boolean = false)
    class Write(val ok: Boolean, val retryable: Boolean = false, val message: String? = null)
    fun read(done: (Read) -> Unit)
    fun write(content: String, clientId: String, done: (Write) -> Unit)
}

/** [HomePage]'s words, as a store for one file. [call] is the page's own (it stops when the page goes). */
class WorkspaceStore(private val path: String, private val call: (String, String, JSONObject, String?, (Reply) -> Unit) -> Unit) : DocStore {
    override fun read(done: (DocStore.Read) -> Unit) = call("body:main", "workspace.read", JSONObject().put("path", path).put("limit", 100_000), null) { r ->
        val t = r.data.str("text")
        done(when { r.ok && t != null -> DocStore.Read(true, t, r.data.optBoolean("truncated")); r.code == "not_found" -> DocStore.Read(true, null); else -> DocStore.Read(false, null) })
    }
    override fun write(content: String, clientId: String, done: (DocStore.Write) -> Unit) =
        call("body:main", "workspace.write", JSONObject().put("path", path).put("content", content), clientId) { r -> done(DocStore.Write(r.ok, r.retryable, failText(r.code))) }
    private fun failText(code: String?) = when (code) { "forbidden", "denied" -> "这次没有得到允许，什么都没改。"; "too_large" -> "内容太长，没能保存，什么都没改。"; else -> null }
}

class PersonaStore(private val path: String, private val call: (String, String, JSONObject, String?, (Reply) -> Unit) -> Unit) : DocStore {
    override fun read(done: (DocStore.Read) -> Unit) = call("service:persona", "get", JSONObject().put("file", path), null) { r ->
        val t = r.data.list("files").firstOrNull { it.str("file") == path }?.str("content")
        done(when { r.ok && t != null -> DocStore.Read(true, t); r.ok || r.code == "not_found" -> DocStore.Read(true, null); else -> DocStore.Read(false, null) })
    }
    override fun write(content: String, clientId: String, done: (DocStore.Write) -> Unit) {
        if (content.isBlank()) { done(DocStore.Write(false, false, "这份内容不能是空的。")); return }
        call("service:persona", "propose", JSONObject().put("file", path).put("content", content).put("reason", "主人在她的主页修改"), clientId) { r ->
            done(if (r.ok && r.data.opt("applied") == false) DocStore.Write(false, false, "这次改动没有马上生效，什么都没改。") else DocStore.Write(r.ok, r.retryable, null))
        }
    }
}

/**
 * A managed Markdown file on a home page: read as the page's own view, changed in a text box. Reading comes before writing (the file must
 * still read as it did when it was loaded), a lost answer keeps its request id, and a file that changed meanwhile is never overwritten.
 */
class DocEditor(private val page: HomePage, private val store: DocStore, private val reading: (String) -> View, private val onSaved: () -> Unit, private val onChange: (DocEditor) -> Unit) {
    private class Pending(val content: String, val base: String, val clientId: String, var sent: Boolean = false)
    private val ctx = page.env.activity
    private val c = AshUi.p(ctx)
    val root = AshUi.vstack(ctx, 14)
    var loaded = false; private set
    var content = ""; private set
    var draft = ""; private set
    var editing = false; private set
    var conflict = false; private set
    var unverified = false; private set
    private var truncated = false
    private var pending: Pending? = null
    private var status = "正在读取…"
    private var disposed = false
    val editable get() = loaded && !truncated
    val busy get() = pending != null
    val dirty get() = loaded && draft != content

    private fun fail(error: Boolean) = if (error) "没能读取，请再试一次。" else ""

    fun dispose() { disposed = true; root.removeAllViews() }

    private fun hideIme() { ctx.currentFocus?.let { ctx.getSystemService(android.view.inputmethod.InputMethodManager::class.java)?.hideSoftInputFromWindow(it.windowToken, 0) } }

    fun load(discardDraft: Boolean = false, done: () -> Unit = {}) {
        if (pending != null) { status = "上次的改动还没确认；请先再点一次同一个按钮。"; render(); return }
        if (loaded && draft != content && !discardDraft) { status = "还有没保存的修改；先保存或取消。"; render(); return }
        store.read { r ->
            if (disposed) return@read
            if (!r.ok) { status = "没能读取，请再试一次。"; render(); done(); return@read }
            content = r.content ?: ""; draft = content; loaded = true; truncated = r.truncated
            conflict = false; unverified = false; pending = null
            status = if (truncated) "内容太长，这里只显示了一部分，不能在这里修改。" else ""
            render(); done()
        }
    }

    fun edit() {
        if (!editable || editing) return
        if (pending == null && !conflict && !unverified && draft == content) load { if (editable) { editing = true; render() } }
        else { editing = true; render() }
    }

    fun cancelEdit() { if (pending != null) return; hideIme(); draft = content; editing = false; if (!truncated) status = ""; render() }

    /** The page's 「编辑」 button: its label, whether it is off, and what a tap does; null while there is nothing to edit. */
    fun button(): Triple<String, Boolean, () -> Unit>? {
        if (!editable) return null
        return if (editing) Triple("取消", pending != null || conflict || unverified) { cancelEdit() } else Triple("编辑", pending != null) { edit() }
    }

    fun save() {
        if (!editable) return
        if (conflict || unverified) { status = "请先重新读取，再保存，以免覆盖别处的修改。"; render(); return }
        if (draft == content && pending == null) { editing = false; render(); return }
        if (pending != null && draft != pending!!.content) { status = "上次保存还没确认；只能原样再试一次。"; render(); return }
        val p = pending ?: Pending(draft, content, UUID.randomUUID().toString()).also { pending = it }
        status = "正在保存…"; render()
        store.read { cur ->
            if (disposed) return@read
            if (!cur.ok) {
                if (!p.sent) pending = null
                status = if (p.sent) "还不确定有没有保存上。再点一次「保存」会原样重试。" else "没能确认文件现在的内容，什么都没改；可以再点一次「保存」。"
                render(); return@read
            }
            val now = cur.content ?: ""
            if (cur.truncated || (now != p.base && !(p.sent && now == p.content))) {
                pending = null; conflict = true; status = "这段内容刚在别处改过，未覆盖。你的修改还在；请重新读取后再改。"; render(); return@read
            }
            val saved = {
                pending = null; content = p.content; unverified = true; status = "正在保存…"; render()
                runCatching { onSaved() }
                store.read { s ->
                    if (!disposed) {
                        if (!s.ok) { unverified = true; status = "已保存，但没能重新读取；请点「重新读取」看看现在的内容。" }
                        else {
                            if (s.content == null || s.truncated || s.content != p.content) { conflict = true; status = "保存后这段内容又在别处被改过。你的修改还在；请重新读取后再看。" }
                            else { content = s.content; draft = s.content; editing = false; status = "已保存。"; hideIme() }
                            unverified = false
                        }
                        render()
                    }
                }
            }
            if (now == p.content) { saved(); return@read }
            p.sent = true
            store.write(p.content, p.clientId) { w ->
                if (disposed) return@write
                if (!w.ok) {
                    if (w.retryable) status = "还不确定有没有保存上。再点一次「保存」会原样重试。"
                    else { pending = null; status = w.message ?: "没有完成，什么都没改；可以再试一次。" }
                    render(); return@write
                }
                saved()
            }
        }
    }

    private var input: EditText? = null

    fun render() {
        if (disposed) return
        root.removeAllViews()
        if (editing) {
            val box = Hk.field(ctx, "", draft, multiline = true).apply {
                isEnabled = loaded && editable && pending == null && !unverified
                addTextChangedListener(object : android.text.TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, d: Int) {}
                    override fun onTextChanged(s: CharSequence?, a: Int, b: Int, d: Int) {}
                    override fun afterTextChanged(s: android.text.Editable?) { draft = s?.toString() ?: "" }
                })
            }
            input = box
            root.addView(box)
        } else if (loaded) root.addView(reading(content))
        val warning = conflict || unverified || pending != null
        if (status.isNotEmpty()) root.addView(Hk.note(ctx, status, if (warning) "warn" else null))
        if (editing) root.addView(AshUi.button(ctx, if (pending != null) "再试一次保存" else "保存", Kind.PRIMARY, block = true) { save() }.also { if (!loaded || !editable || conflict || unverified) AshUi.disable(it) })
        if (conflict || unverified) root.addView(AshUi.button(ctx, if (editing) "重新读取（放弃修改）" else "重新读取", Kind.NEUTRAL, block = true) { load(discardDraft = true) })
        onChange(this)
    }
}

/** A page of two files with a switch between them and an 「编辑」 button on the bar. */
abstract class HmDocs(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    protected class DocFile(val path: String, val label: String)
    protected abstract val files: List<DocFile>
    protected abstract fun store(path: String): DocStore
    protected abstract fun view(path: String, content: String): View
    protected abstract fun foot(path: String): String
    protected open fun count(path: String, content: String): Int? = null
    protected open fun saved(path: String) {}
    protected open fun header(): View? = null

    private val counts = HashMap<String, Int?>()
    private var active: String? = null
    private var editor: DocEditor? = null
    private val segSlot = FrameLayout(ctx)
    private val slot = AshUi.vstack(ctx, 14)
    private val barButton: TextView = AshUi.text(ctx, "编辑", AshType(14f, 20f, 600, null), c.youText).apply { gravity = Gravity.CENTER; isClickable = true; visibility = View.GONE }
    override val trailing: View get() = barButton

    protected fun start() { header()?.let { body.addView(it) }; body.addView(segSlot); body.addView(slot) }

    private fun sync() {
        val b = editor?.button()
        barButton.visibility = if (b == null) View.GONE else View.VISIBLE
        if (b != null) { barButton.text = b.first; barButton.alpha = if (b.second) 0.4f else 1f; barButton.setOnClickListener { if (!b.second) b.third() } }
        segSlot.removeAllViews()
        val locked = editor?.editing == true || editor?.busy == true
        segSlot.addView(AshUi.segmented(ctx, files.map { f -> counts[f.path]?.let { "${f.label} · $it" } ?: f.label }, files.indexOfFirst { it.path == active }.coerceAtLeast(0)) { i -> if (!locked) open(files[i].path) })
    }

    private fun open(path: String) {
        val e = editor
        if (e != null && (e.busy || e.dirty)) return
        e?.dispose()
        active = path
        slot.removeAllViews()
        val panel = AshUi.vstack(ctx)
        slot.addView(panel); slot.addView(AshPageFoot(foot(path)))
        val ed = DocEditor(this, store(path), { content -> view(path, content) }, { saved(path) }) { x -> if (editor === x) { counts[path] = if (x.loaded) count(path, x.content) else null; sync() } }
        editor = ed
        panel.addView(ed.root)
        sync()
        ed.load { if (alive) sync() }
    }

    private fun AshPageFoot(text: String) = ai.ash.ui.design.AshPage.foot(ctx, text)

    protected fun storeCall(): (String, String, JSONObject, String?, (Reply) -> Unit) -> Unit = { to, word, b, id, done -> call(to, word, b, id, done) }

    override fun refresh() {
        val e = editor
        if (e != null) { if (!e.editing && !e.busy) e.load(); return }
        open(files[0].path)
        files.drop(1).forEach { f -> store(f.path).read { r -> if (alive && r.ok) { counts[f.path] = count(f.path, r.content ?: ""); sync() } } }
    }
    override fun onDispose() { editor?.dispose() }
}

class HmMemory(env: HomeEnv, arg: String?) : HmDocs(env, arg) {
    override val title = "她记得你"
    override val files = listOf(DocFile("USER.md", "关于你"), DocFile("MEMORY.md", "她的笔记"))
    override fun store(path: String) = WorkspaceStore(path, storeCall())
    override fun count(path: String, content: String): Int? = HomeModel.memoryCount(HomeModel.groupMemory(content))
    override fun foot(path: String) = if (path == "USER.md") "她会自己整理，按话题分好。记错了，点「编辑」直接改。" else "这是她给自己记的笔记。她会自己整理；记错了，点「编辑」直接改。"
    override fun view(path: String, content: String): View {
        val groups = HomeModel.groupMemory(content)
        if (groups.isEmpty()) return Hk.list(ctx, listOf(Hk.row(ctx, "pen", if (path == "USER.md") "她还没记下关于你的事" else "她还没有笔记", "聊得多了，她会自己整理在这里；也可以点「编辑」自己写。")))
        return AshUi.vstack(ctx, 14).apply {
            groups.forEach { g ->
                val rows = g.items.map { text -> AshUi.row(ctx, text, null, null).apply { minimumHeight = dp(48); (getChildAt(0) as? LinearLayout)?.getChildAt(0)?.let { (it as TextView).setTextColor(if (HomeModel.urgentGroup(g.title)) c.err else c.ink) } } }
                addView(AshUi.group(ctx, g.title.ifEmpty { null }, rows = rows, iconInset = false))
            }
        }
    }
    init { start() }
}

class HmIdentity(env: HomeEnv, arg: String?) : HmDocs(env, arg) {
    override val title = "她是谁"
    override val files = listOf(DocFile("SOUL.md", "她的性格"), DocFile("IDENTITY.md", "名片"))
    override fun store(path: String) = PersonaStore(path, storeCall())
    override fun foot(path: String) = "这些决定了她是谁、怎样和你相处，改完她下一句话就照新的来。想给她换个名字？直接跟她说。"
    override fun saved(path: String) { if (path == "IDENTITY.md") { env.names.refresh(); later(400) { readSub() } } }
    private val nameView = AshUi.text(ctx, env.names.name, AshType(22f, 28f, 700, null), c.onMe)
    private val subView = AshUi.text(ctx, "", AshType(13f, 18f, 400, null), c.onMe).apply { alpha = 0.75f }
    private val off = env.names.listen { n -> nameView.text = n }

    override fun header(): View = FrameLayout(ctx).apply {
        background = AshUi.rounded(c.bubbleMe, AshUi.dpF(ctx, 24f)); clipToOutline = true
        outlineProvider = object : android.view.ViewOutlineProvider() { override fun getOutline(v: View, o: android.graphics.Outline) { o.setRoundRect(0, 0, v.width, v.height, AshUi.dpF(ctx, 24f)) } }
        AshUi.cardShadow(this, 2f)
        // the pale ring in the corner: drawn, not laid out, so it takes no room
        addView(object : View(ctx) {
            private val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { style = android.graphics.Paint.Style.STROKE; strokeWidth = AshUi.dpF(ctx, 18f); color = c.herSoft }
            override fun onDraw(canvas: android.graphics.Canvas) { canvas.drawCircle(width - AshUi.dpF(ctx, 60f), AshUi.dpF(ctx, 40f), AshUi.dpF(ctx, 91f), paint) }
        }, FrameLayout.LayoutParams(-1, -1))
        addView(AshUi.hstack(ctx, 16).apply {
            setPadding(dp(20), dp(20), dp(20), dp(20))
            addView(OnboardingViews.avatar(ctx, "default", 56))
            addView(AshUi.vstack(ctx, 4).apply { addView(nameView); addView(subView) }, LinearLayout.LayoutParams(0, -2, 1f))
        })
    }

    private fun readSub() = call("service:persona", "get", JSONObject().put("file", "IDENTITY.md")) { r ->
        if (r.ok) subView.text = HomeModel.identitySub(r.data.list("files").firstOrNull { it.str("file") == "IDENTITY.md" }?.str("content"))
    }
    override fun refresh() { readSub(); super.refresh() }
    override fun onDispose() { off(); super.onDispose() }

    override fun view(path: String, content: String): View = AshUi.card(ctx, 12).apply {
        setPadding(dp(20), dp(20), dp(20), dp(18))
        var any = false
        var bullets: LinearLayout? = null
        for (raw in content.split(Regex("\\r?\\n"))) {
            val line = raw.trim()
            if (line.isEmpty()) { bullets = null; continue }
            if (Regex("^#\\s").containsMatchIn(line)) continue
            any = true
            val plain = { s: String -> s.replace(Regex("\\*\\*(.+?)\\*\\*"), "$1").replace(Regex("`([^`]+)`"), "$1") }
            val heading = Regex("^#{1,6}\\s+(.*)$").find(line)
            val bullet = Regex("^(?:[-*+]|\\d+[.)])\\s+(.*)$").find(line)
            when {
                heading != null -> { bullets = null; addView(AshUi.text(ctx, plain(heading.groupValues[1]), AshType(17f, 26f, 650, Role.INK))) }
                bullet != null -> {
                    if (bullets == null) { bullets = AshUi.vstack(ctx, 4).apply { setPadding(dp(8), 0, 0, 0) }; addView(bullets) }
                    bullets.addView(AshUi.text(ctx, "•  " + plain(bullet.groupValues[1]), AshType(15.5f, 27f, 400, Role.TEXT)))
                }
                else -> { bullets = null; addView(AshUi.text(ctx, plain(line), AshType(15.5f, 27f, 400, Role.TEXT))) }
            }
        }
        if (!any) addView(AshUi.text(ctx, "还没有写下什么。点「编辑」写几句。", AshType(15.5f, 27f, 400, Role.TEXT_3)))
        else if (path == "SOUL.md" && content.isNotBlank()) addView(AshUi.text(ctx, "— ${env.names.name}", AshType(14f, 22f, 400, Role.TEXT_3)).apply { gravity = Gravity.END }, LinearLayout.LayoutParams(-1, -2))
    }
    init { start() }
}
