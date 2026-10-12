package ai.ash.ui

import ai.ash.R
import ai.ash.apps.Ui
import ai.ash.ui.design.AshPage
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.Role
import ai.ash.widget.CardText
import ai.ash.widget.Mark
import ai.ash.widget.Markdown
import android.app.Activity
import android.app.Dialog
import android.graphics.Typeface
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.Color
import android.graphics.ImageDecoder
import android.os.Build
import android.text.Html
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.WindowCompat
import java.nio.ByteBuffer
import java.text.Collator

/**
 * The file viewer over the chat (what the web page's files.js was): open one file of a body, a file's folder, the folders of a
 * body, or a link in a message; bytes that are already at hand (an attachment of a message) too. It reads through [access], shows
 * images, text, Markdown and web pages (a page as its text only — nothing in it runs or loads), and puts a file where the owner
 * chooses through [save]. Everything it shows is drawn natively; there is no web view.
 */
class FileViewer(
    private val activity: Activity,
    private val access: FileAccess,
    /** [done] gets true when saved, false when it failed, null when the owner cancelled. */
    private val save: (name: String, mime: String, bytes: ByteArray, done: (Boolean?) -> Unit) -> Unit,
) {
    private val ctx get() = activity
    private var dialog: Dialog? = null
    private var page: LinearLayout? = null
    private var actions: LinearLayout? = null
    private var note: TextView? = null
    private var body: LinearLayout? = null
    /** Every shell() starts a new generation: what an earlier one was still waiting for is dropped when it arrives. */
    private var gen = 0

    // ---------- the shell ----------

    private fun shell(title: String): Int {
        gen++
        val d = dialog ?: AshDialogs.make(activity, opaque = true).also { (made, frame) ->
            dialog = made
            val p = AshUi.vstack(ctx).apply { setBackgroundColor(AshUi.p(ctx).bg) }
            frame.addView(p, FrameLayout.LayoutParams(-1, -1))
            Ui.insets(frame)
            page = p
            made.setOnDismissListener { gen++; body?.removeAllViews(); page?.removeAllViews() }
        }.first
        val p = page!!
        p.removeAllViews()
        p.addView(AshPage.navbar(ctx, title, "关闭") { d.dismiss() })
        actions = AshUi.hstack(ctx, 8).also { row ->
            p.addView(HorizontalScrollView(ctx).apply { isHorizontalScrollBarEnabled = false; addView(row) }, LinearLayout.LayoutParams(-1, -2))
            row.setPadding(AshUi.dp(ctx, AshTokens.Space.pageX), 0, AshUi.dp(ctx, AshTokens.Space.pageX), 0)
        }
        note = AshUi.text(ctx, "", AshTokens.Type.sub).apply {
            setPadding(AshUi.dp(ctx, AshTokens.Space.pageX), AshUi.dp(ctx, 8), AshUi.dp(ctx, AshTokens.Space.pageX), AshUi.dp(ctx, 4))
            setTextIsSelectable(true); visibility = View.GONE
        }
        p.addView(note)
        body = AshUi.vstack(ctx, 8).apply { setPadding(AshUi.dp(ctx, AshTokens.Space.pageX), AshUi.dp(ctx, 8), AshUi.dp(ctx, AshTokens.Space.pageX), AshUi.dp(ctx, 24)) }
        p.addView(ScrollView(ctx).apply { isFillViewport = true; addView(body, ViewGroup.LayoutParams(-1, -2)) }, LinearLayout.LayoutParams(-1, 0, 1f))
        if (!d.isShowing) d.show()
        return gen
    }

    private fun say(text: String) { note?.apply { this.text = text; visibility = if (text.isEmpty()) View.GONE else View.VISIBLE } }
    private fun muted(text: String) { body?.addView(AshUi.text(ctx, text, AshTokens.Type.callout)) }
    private fun action(label: String, onClick: (View) -> Unit): TextView {
        lateinit var b: TextView
        b = AshUi.button(ctx, label, AshUi.Kind.NEUTRAL, AshUi.BtnSize.SM) { onClick(b) }
        actions?.addView(b)
        return b
    }
    private fun busy(b: View, on: Boolean) { b.isEnabled = !on; b.alpha = if (on) 0.4f else 1f }

    // ---------- opening ----------

    /** A link in a message or in a file: a path on a body, resolved against the file it is in. */
    fun openLink(href: String, base: FileRef = FileRef("main", "")) {
        val ref = FileLinks.resolve(href, base)
        if (ref == null) { shell("打开文件"); say("这个路径不能打开"); return }
        open(ref)
    }

    fun open(ref: FileRef) {
        val valid = FileLinks.ref(ref.workspace, ref.path, ref.name)
        val g = shell(ref.baseName.ifEmpty { "文件" })
        if (valid == null) { say("文件路径无效"); return }
        val bodyId = valid.body ?: run { say("打不开：不知道这个文件在哪台设备上"); return }
        say("")
        action("所在文件夹") { browse(bodyId, valid.directory) }
        action("下载") { b ->
            busy(b, true)
            fetch(bodyId, valid.path, g, always = true) { bytes ->
                if (bytes == null) { busy(b, false); return@fetch }
                val name = valid.path.substringAfterLast('/')
                save(name, bytes.mime ?: "application/octet-stream", bytes.data) { ok ->
                    busy(b, false)
                    if (g == gen) say(when (ok) { true -> "文件已保存"; null -> "已取消保存"; false -> "保存失败" })
                }
            }
        }
        val ext = FileLinks.extension(valid.path)
        if (ext !in FileLinks.HTML && ext !in FileLinks.TEXTS && ext !in FileLinks.IMAGES) { muted("这种格式暂未接入内置阅读器，请下载后打开。"); return }
        fetch(bodyId, valid.path, g) { bytes -> if (bytes != null) render(ext, bytes.mime, bytes.data, valid.path, valid) }
    }

    /** Bytes that are already here (an attachment): shown by the name's ending or the type, and saved from the bar. */
    fun show(name: String, mime: String, bytes: ByteArray) {
        val g = shell(name)
        say("")
        action("保存") { b ->
            busy(b, true)
            save(name, mime, bytes) { ok -> busy(b, false); if (g == gen) say(when (ok) { true -> "文件已保存"; null -> "已取消保存"; false -> "保存失败" }) }
        }
        val ext = FileLinks.extension(name).ifEmpty { if (mime.startsWith("image/")) mime.substringAfter('/') else "" }
        if (ext in FileLinks.IMAGES || ext in FileLinks.TEXTS || ext in FileLinks.HTML) render(ext, mime, bytes, name, null) else muted("这种格式暂未接入内置阅读器，请保存后打开。")
    }

    /** Reads a file for the shell [g]; [onBytes] gets null (and the note says why) when it could not be had. [always]: also when the shell has moved on. */
    private fun fetch(bodyId: String, path: String, g: Int, always: Boolean = false, onBytes: (FileAccess.Bytes?) -> Unit) {
        access.read(bodyId, path) { bytes, why ->
            if (g != gen && !always) return@read
            when {
                bytes == null -> { if (g == gen) say(why?.message?.ifEmpty { null } ?: "文件无法打开"); onBytes(null) }
                bytes.data.size > FileLinks.MAX_READ_BYTES -> { if (g == gen) say("文件超过当前 20 MiB 的限制"); onBytes(null) }
                else -> onBytes(bytes)
            }
        }
    }

    private fun render(ext: String, mime: String?, data: ByteArray, label: String, base: FileRef?) {
        val box = body ?: return
        when {
            ext in FileLinks.IMAGES -> {
                val view = Pictures.view(ctx, data, label) ?: run { say("图片无法显示"); return }
                box.addView(view, LinearLayout.LayoutParams(-1, -2))
            }
            ext in FileLinks.HTML -> {
                say("网页阅读模式（不运行脚本，不加载其中的图片和样式表）")
                box.addView(readable(Html.fromHtml(Pictures.stripHtml(String(data, Charsets.UTF_8)), Html.FROM_HTML_MODE_COMPACT)))
            }
            ext == "md" || ext == "markdown" -> box.addView(readable(markdown(String(data, Charsets.UTF_8), base)))
            else -> box.addView(readable(String(data, Charsets.UTF_8), mono = true))
        }
    }

    private fun readable(text: CharSequence, mono: Boolean = false) =
        AshUi.text(ctx, text, if (mono) AshType(13.5f, 20f, 400, Role.TEXT) else AshTokens.Type.body).apply {
            setTextIsSelectable(true)
            if (mono) typeface = Typeface.MONOSPACE
            if (text is Spanned && text.getSpans(0, text.length, ClickableSpan::class.java).isNotEmpty()) movementMethod = LinkMovementMethod.getInstance()
        }

    /** Markdown as formatting; a link to a file on a body opens in this viewer, next to the file it is in. */
    private fun markdown(raw: String, base: FileRef?): CharSequence {
        val styled = Markdown.parse(raw)
        val out = SpannableStringBuilder(CardText.spanned(styled, AshUi.p(ctx).youText))
        val hrefs = markdownLinks(raw)
        for (s in styled.spans) {
            if (s.mark != Mark.LINK) continue
            val href = hrefs[styled.text.substring(s.start.coerceIn(0, styled.text.length), s.end.coerceIn(0, styled.text.length))] ?: continue
            if (FileLinks.resolve(href, base ?: FileRef("main", "")) == null) continue
            out.setSpan(object : ClickableSpan() { override fun onClick(widget: View) = openLink(href, base ?: FileRef("main", "")) },
                s.start.coerceIn(0, out.length), s.end.coerceIn(0, out.length), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        return out
    }

    // ---------- browsing ----------

    /** The folders of a body ([bodyId] null: the first one the hub has). */
    fun browse(bodyId: String? = null, path: String = "") {
        val g = shell(path.ifEmpty { "文件" })
        say("正在读取…")
        access.bodies { bodies, why ->
            if (g != gen) return@bodies
            if (bodies == null) { say(why?.message?.ifEmpty { null } ?: "文件无法读取"); return@bodies }
            val current = bodyId ?: bodies.firstOrNull()?.id
            if (current == null) { say("暂无可浏览的文件"); return@bodies }
            if (bodies.size > 1) body?.addView(HorizontalScrollView(ctx).apply {
                isHorizontalScrollBarEnabled = false
                addView(AshUi.hstack(ctx, 8).apply {
                    for (b in bodies) addView(AshUi.option(ctx, if (b.id == FileAccess.MAIN) "Ash 的容器" else b.name, selected = b.id == current) { browse(b.id) })
                })
            })
            action("刷新") { browse(current, path) }
            access.list(current, path) { listing, why2 ->
                if (g != gen) return@list
                if (listing == null) { say(why2?.message?.ifEmpty { null } ?: "文件无法读取"); return@list }
                say(listing.path.ifEmpty { path.ifEmpty { "/" } })
                val box = body ?: return@list
                val rows = ArrayList<View>()
                if (path.isNotEmpty()) rows.add(AshUi.row(ctx, "← 上一级", icon = AshPage.icon(ctx, R.drawable.ash_ic_folder)) { browse(current, path.substringBeforeLast('/', "")) })
                val collator = Collator.getInstance()
                for (e in listing.entries.sortedWith(compareBy<FileAccess.Entry> { !it.directory }.thenComparator { a, b -> collator.compare(a.name, b.name) })) {
                    val child = if (path.isEmpty()) e.name else "$path/${e.name}"
                    rows.add(AshUi.row(ctx, e.name, sub = if (!e.directory && e.size != null) "${(e.size + 1023) / 1024} KB" else null,
                        icon = AshPage.icon(ctx, if (e.directory) R.drawable.ash_ic_folder else R.drawable.ash_ic_file),
                        trailing = if (e.directory) chevron() else null) { if (e.directory) browse(current, child) else open(FileRef(current, child)) })
                }
                if (listing.entries.isEmpty()) muted("此目录为空")
                if (rows.isNotEmpty()) box.addView(AshUi.group(ctx, rows = rows))
                if (listing.truncated) muted("只显示了前面一部分")
            }
        }
    }

    private fun chevron() = View(ctx).apply {
        background = AshPage.icon(ctx, R.drawable.ash_ic_chev).apply { setTint(AshUi.p(ctx).text3) }
        layoutParams = LinearLayout.LayoutParams(AshUi.dp(ctx, 18), AshUi.dp(ctx, 18))
    }

    fun dismiss() { dialog?.dismiss() }

    companion object {
        private val LINK = Regex("\\[([^\\]]*)]\\(([^)\\s]*)[^)]*\\)")

        /** The `[label](href)` pairs of a Markdown text outside code fences, by label (the first one of a label wins). */
        fun markdownLinks(raw: String): Map<String, String> {
            val found = LinkedHashMap<String, String>()
            var fence = false
            for (line in raw.replace("\r\n", "\n").split('\n')) {
                if (line.trimStart().startsWith("```")) { fence = !fence; continue }
                if (fence) continue
                for (m in LINK.findAll(line)) found.putIfAbsent(m.groupValues[1], m.groupValues[2])
            }
            return found
        }
    }
}

/** Pictures from bytes: a view for the viewer, a small bitmap for a message. */
internal object Pictures {
    private const val MAX_SIDE = 4096

    fun view(ctx: android.content.Context, data: ByteArray, label: String): View? {
        val image = ImageView(ctx).apply { adjustViewBounds = true; scaleType = ImageView.ScaleType.FIT_CENTER; contentDescription = label }
        if (Build.VERSION.SDK_INT >= 28) {
            val drawable: Drawable = runCatching { decodeDrawable(data) }.getOrNull() ?: return null
            image.setImageDrawable(drawable)
            if (drawable is AnimatedImageDrawable) {
                // A GIF or an animated WebP plays while it is on screen and only then.
                drawable.repeatCount = AnimatedImageDrawable.REPEAT_INFINITE
                image.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
                    override fun onViewAttachedToWindow(v: View) { if (AshUi.motionOn(ctx)) drawable.start() }
                    override fun onViewDetachedFromWindow(v: View) { drawable.stop() }
                })
            }
        } else image.setImageBitmap(bitmap(data, MAX_SIDE) ?: return null)
        return image
    }

    @android.annotation.SuppressLint("NewApi")
    private fun decodeDrawable(data: ByteArray): Drawable =
        ImageDecoder.decodeDrawable(ImageDecoder.createSource(ByteBuffer.wrap(data))) { decoder, info, _ ->
            var k = 1
            while (maxOf(info.size.width, info.size.height) / k > MAX_SIDE) k *= 2
            if (k > 1) decoder.setTargetSampleSize(k)
        }

    /** A bitmap no bigger than about [maxSide] on its long side, turned the way the picture says (EXIF), or null. */
    fun bitmap(data: ByteArray, maxSide: Int): android.graphics.Bitmap? {
        val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
        if (bounds.outWidth < 1 || bounds.outHeight < 1) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
        val raw = android.graphics.BitmapFactory.decodeByteArray(data, 0, data.size, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        val turn = runCatching {
            when (android.media.ExifInterface(java.io.ByteArrayInputStream(data)).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)) {
                android.media.ExifInterface.ORIENTATION_ROTATE_90 -> 90f; android.media.ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                android.media.ExifInterface.ORIENTATION_ROTATE_270 -> 270f; else -> 0f
            }
        }.getOrDefault(0f)
        if (turn == 0f) return raw
        return android.graphics.Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, android.graphics.Matrix().apply { postRotate(turn) }, true)
    }

    /** A web page as the text it holds: no scripts, styles, images or comments are left to run or to load. */
    fun stripHtml(html: String): String = html
        .replace(Regex("<!--.*?-->", RegexOption.DOT_MATCHES_ALL), "")
        .replace(Regex("<(script|style|noscript|template|iframe|object|embed)\\b.*?</\\1\\s*>", setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE)), "")
        .replace(Regex("<(img|link|meta|script|style|source|video|audio|iframe|embed)\\b[^>]*>", RegexOption.IGNORE_CASE), "")
}

/** The full-screen and the see-through dialogs the file parts stand on (edge to edge, like the app's pages). */
internal object AshDialogs {
    fun make(activity: Activity, opaque: Boolean): Pair<Dialog, FrameLayout> {
        val d = Dialog(activity, if (opaque) android.R.style.Theme_Material_NoActionBar else android.R.style.Theme_Translucent_NoTitleBar)
        val frame = FrameLayout(activity)
        d.setContentView(frame, ViewGroup.LayoutParams(-1, -1))
        d.window?.apply {
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            WindowCompat.setDecorFitsSystemWindows(this, false)
            statusBarColor = Color.TRANSPARENT; navigationBarColor = Color.TRANSPARENT
            setBackgroundDrawable(ColorDrawable(if (opaque) AshUi.p(activity).bg else Color.TRANSPARENT))
            WindowCompat.getInsetsController(this, decorView).apply {
                val light = !AshUi.night(activity)
                isAppearanceLightStatusBars = light; isAppearanceLightNavigationBars = light
            }
        }
        return d to frame
    }
}
