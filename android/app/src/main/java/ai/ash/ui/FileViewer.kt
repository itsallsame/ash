package ai.ash.ui

import ai.ash.R
import ai.ash.apps.Ui
import ai.ash.caps.camera.CaptureProvider
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
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
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
import android.webkit.MimeTypeMap
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.WindowCompat
import java.io.File
import java.nio.ByteBuffer
import java.text.Collator

/**
 * The file viewer over the chat (what the web page's files.js was): open one file of a body, a file's folder, the folders of a
 * body, or a link in a message; bytes that are already at hand (an attachment of a message) too. It reads through [access] and shows
 * what it can with what the system has: images, PDF (page by page), sound and video (the system's players), tables (CSV / TSV), JSON,
 * text and code, Markdown, and web pages (a page as its text only — nothing in it runs or loads). Every file also has two ways out:
 * to another application on the phone, and to where the owner chooses through [save]. Everything it shows is drawn natively;
 * there is no web view. A file above [FileLinks.MAX_READ_BYTES] is not shown, only handed on.
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
    private var scroll: ScrollView? = null
    /** Every shell() starts a new generation: what an earlier one was still waiting for is dropped when it arrives. */
    private var gen = 0
    /** What this shell has read (so a save or a hand-over does not read again), the file in the app's cache a player, the PDF or another app reads, and what is playing. */
    private var loaded: FileAccess.Bytes? = null
    private var staged: File? = null
    private var handedOut = false
    private var playing: FilePreviews.Playing? = null
    private var pdf: PdfPages? = null

    // ---------- the shell ----------

    /** Lets go of what the shell held: players and the PDF stop, the cache file goes (unless another application was given it: a day's time clears that). */
    private fun release() {
        gen++
        playing?.release(); playing = null
        pdf?.release(); pdf = null
        loaded = null
        if (!handedOut) staged?.delete()
        staged = null; handedOut = false
    }

    private fun shell(title: String): Int {
        release()
        val d = dialog ?: AshDialogs.make(activity, opaque = true).also { (made, frame) ->
            dialog = made
            val p = AshUi.vstack(ctx).apply { setBackgroundColor(AshUi.p(ctx).bg) }
            frame.addView(p, FrameLayout.LayoutParams(-1, -1))
            Ui.insets(frame)
            page = p
            made.setOnDismissListener { release(); body?.removeAllViews(); page?.removeAllViews() }
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
        scroll = ScrollView(ctx).apply { isFillViewport = true; addView(body, ViewGroup.LayoutParams(-1, -2)) }
        p.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
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
        val name = valid.path.substringAfterLast('/')
        action("所在文件夹") { browse(bodyId, valid.directory) }
        action("下载") { b ->
            busy(b, true)
            read(bodyId, valid.path, g) { bytes ->
                if (bytes == null) { busy(b, false); return@read }
                save(name, bytes.mime ?: "application/octet-stream", bytes.data) { ok ->
                    busy(b, false)
                    if (g == gen) say(when (ok) { true -> "文件已保存"; null -> "已取消保存"; false -> "保存失败" })
                }
            }
        }
        action("用其它应用打开") { b ->
            busy(b, true)
            read(bodyId, valid.path, g) { bytes -> busy(b, false); if (bytes != null && g == gen) openWith(name, bytes) }
        }
        // A file whose ending says it needs another application is not read just to be looked at.
        if (FileFormats.kindOfName(FileLinks.extension(valid.path)) == FileFormats.Kind.OTHER) { muted(NO_READER); return }
        read(bodyId, valid.path, g) { bytes -> if (bytes != null && g == gen) present(name, bytes, valid) }
    }

    /** Bytes that are already here (an attachment): shown by the name's ending, the type or the bytes, and handed on or saved from the bar. */
    fun show(name: String, mime: String, bytes: ByteArray) {
        val g = shell(name)
        say("")
        val have = FileAccess.Bytes(bytes, mime).also { loaded = it }
        action("保存") { b ->
            busy(b, true)
            save(name, mime, bytes) { ok -> busy(b, false); if (g == gen) say(when (ok) { true -> "文件已保存"; null -> "已取消保存"; false -> "保存失败" }) }
        }
        action("用其它应用打开") { openWith(name, have) }
        present(name, have, null)
    }

    /**
     * Reads a file for the shell [g] (once: what the shell has read is kept until it closes); [onBytes] gets null (and the note says
     * why) when it could not be had. It is called also when the shell has moved on, with what was read.
     */
    private fun read(bodyId: String, path: String, g: Int, onBytes: (FileAccess.Bytes?) -> Unit) {
        loaded?.let { return onBytes(it) }
        access.read(bodyId, path) { bytes, why ->
            if (bytes != null && g == gen) loaded = bytes
            if (bytes == null && g == gen) say(when {
                why?.code == "too_large" -> "文件太大（超过 64 MiB），读不进来，无法预览或保存"
                else -> why?.message?.ifEmpty { null } ?: "文件无法打开"
            })
            onBytes(bytes)
        }
    }

    /** The file in the app's cache, made once for this shell: what the players and the PDF read, and what another application is given. */
    private fun stage(name: String, data: ByteArray): File = staged ?: CaptureProvider.newNamedFile(ctx, name).also { it.writeBytes(data); staged = it }

    /** Gives the file to the system's chooser of applications that can show it. */
    private fun openWith(name: String, bytes: FileAccess.Bytes) {
        val uri = CaptureProvider.uriFor(ctx, stage(name, bytes.data))
        handedOut = true
        val type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(FileLinks.extension(name)) ?: bytes.mime?.takeIf { it != "application/octet-stream" } ?: "*/*"
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        view.clipData = ClipData.newRawUri(name, uri)
        try { activity.startActivity(Intent.createChooser(view, "用其它应用打开")) }
        catch (e: ActivityNotFoundException) { say("手机上没有能打开这种文件的应用") }
        catch (e: SecurityException) { say("没能交给其它应用") }
    }

    /** Shows [bytes] the way its kind says; a file too big, or of no kind this viewer knows, is left to the two buttons. */
    private fun present(name: String, bytes: FileAccess.Bytes, base: FileRef?) {
        val box = body ?: return
        val data = bytes.data
        if (data.size > FileLinks.MAX_READ_BYTES) { muted("文件超过 20 MiB，不在这里预览。可以用其它应用打开，或保存。"); return }
        val kind = FileFormats.kind(FileLinks.extension(name), bytes.mime, data)
        val (text, cut) = if (kind in TEXTUAL) FileFormats.preview(data) else "" to false
        val tail = if (cut) "文件较大，只显示了前 1 MiB" else ""
        when (kind) {
            FileFormats.Kind.IMAGE -> {
                val view = Pictures.view(ctx, data, name) ?: run { say("图片无法显示。可以用其它应用打开，或保存。"); return }
                box.addView(view, LinearLayout.LayoutParams(-1, -2))
            }
            FileFormats.Kind.PDF -> {
                val pages = PdfPages(ctx, stage(name, data), scroll ?: return) { say("这个 PDF 打不开（可能有密码或已损坏）。可以用其它应用打开，或保存。") }
                pdf = pages
                box.addView(pages.view, LinearLayout.LayoutParams(-1, -2))
            }
            FileFormats.Kind.AUDIO, FileFormats.Kind.VIDEO -> {
                val file = stage(name, data)
                val fail = { say("系统播放不了这种编码。可以用其它应用打开，或保存。") }
                val p = if (kind == FileFormats.Kind.AUDIO) FilePreviews.audio(ctx, file, fail) else FilePreviews.video(ctx, file, fail)
                playing = p
                box.addView(p.view, LinearLayout.LayoutParams(-1, -2))
            }
            FileFormats.Kind.TABLE -> {
                val table = FileFormats.parseDelimited(text, if (FileLinks.extension(name) == "tsv") '\t' else ',', TABLE_ROWS, TABLE_COLUMNS)
                if (table.rows.isEmpty()) { muted("表格是空的"); return }
                say(listOfNotNull(if (table.moreRows) "只显示了前 $TABLE_ROWS 行" else tail.ifEmpty { null }, "只显示了前 $TABLE_COLUMNS 列".takeIf { table.moreColumns }).joinToString("；"))
                box.addView(FilePreviews.table(ctx, table), LinearLayout.LayoutParams(-1, -2))
            }
            FileFormats.Kind.JSON -> {
                val pretty = if (cut) null else FileFormats.prettyJson(text)
                say(if (cut) "$tail，没有排版" else "")
                box.addView(readable(pretty ?: text, mono = true))
            }
            FileFormats.Kind.HTML -> {
                say("网页阅读模式（不运行脚本，不加载其中的图片和样式表）" + if (cut) "；$tail" else "")
                box.addView(readable(Html.fromHtml(Pictures.stripHtml(text), Html.FROM_HTML_MODE_COMPACT)))
            }
            FileFormats.Kind.MARKDOWN -> { say(tail); box.addView(readable(markdown(text, base))) }
            FileFormats.Kind.TEXT -> { say(tail); box.addView(readable(text, mono = true)) }
            FileFormats.Kind.OTHER -> muted(NO_READER)
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
        private const val NO_READER = "这种格式暂无内置阅读器。可以用其它应用打开，或保存。"
        private const val TABLE_ROWS = 300
        private const val TABLE_COLUMNS = 20
        private val TEXTUAL = setOf(FileFormats.Kind.TABLE, FileFormats.Kind.JSON, FileFormats.Kind.HTML, FileFormats.Kind.MARKDOWN, FileFormats.Kind.TEXT)
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
