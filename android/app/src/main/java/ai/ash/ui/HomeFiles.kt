package ai.ash.ui

import android.content.ContentValues
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.View
import android.webkit.MimeTypeMap
import android.widget.ImageView
import android.widget.LinearLayout
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.AshUi.Kind
import ai.ash.ui.design.Role
import org.json.JSONObject
import java.io.File

private const val SEP = "\u0001"
private const val MAIN = "body:main"

/** 她的文件: the files of her work directory (or of a computer she uses), browsed as a list; a file opens in the reader. */
class HmFiles(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "她的文件"
    private var bodies: List<JSONObject> = emptyList()
    private var bodyId: String? = arg?.takeIf { it.startsWith("dir:") }?.removePrefix("dir:")?.substringBefore(SEP)
    private var path = arg?.takeIf { it.startsWith("dir:") }?.removePrefix("dir:")?.substringAfter(SEP, "") ?: ""
    private var openName: String? = arg?.takeIf { !it.startsWith("dir:") }
    private var listing: JSONObject? = null
    private var failed = ""

    init { redraw { addView(Hk.note(ctx, "正在读取…")) } }

    override fun refresh() = load()

    private fun load() {
        val begin = {
            val b = bodyId ?: bodies.firstOrNull()?.str("body")
            if (b == null) { failed = "暂无可浏览的文件"; draw() }
            else {
                bodyId = b
                call(b, "workspace.ls", JSONObject().also { if (path.isNotEmpty()) it.put("path", path) }) { r ->
                    if (!r.ok) { failed = r.failure?.message ?: "文件无法读取"; draw(); return@call }
                    listing = r.data; failed = ""; draw()
                    openName?.let { n -> openName = null; env.nav.go("file", "$b$SEP${if (path.isEmpty()) n else "$path/$n"}") }
                }
            }
        }
        if (bodies.isNotEmpty()) { begin(); return }
        call("service:bodies", "list") { r ->
            if (!r.ok) { failed = r.failure?.message ?: "文件无法读取"; draw(); return@call }
            bodies = r.data.list("bodies").sortedBy { if (it.str("body") == MAIN) 0 else 1 }
            begin()
        }
    }

    private fun draw(): Unit = redraw {
        if (failed.isNotEmpty()) { addView(Hk.note(ctx, failed, "warn")); addView(AshUi.button(ctx, "重试", Kind.NEUTRAL, AshUi.BtnSize.SM) { load() }); return@redraw }
        val l = listing ?: return@redraw
        if (bodies.size > 1) addView(AshUi.segmented(ctx, bodies.map { if (it.str("body") == MAIN) "她的容器" else it.str("name") ?: it.str("body") ?: "" }, bodies.indexOfFirst { it.str("body") == bodyId }.coerceAtLeast(0)) { i ->
            bodyId = bodies[i].str("body"); path = ""; load()
        })
        val entries = l.list("entries").filter { path.isNotEmpty() || !HomeModel.isSystemEntry(it.str("name") ?: "", it.str("type") == "directory") }
            .sortedWith(compareBy({ if (it.str("type") == "directory") 0 else 1 }, { it.str("name") ?: "" }))
        val rows = ArrayList<View>()
        if (path.isNotEmpty()) rows.add(Hk.row(ctx, "back", "上一级") { path = path.substringBeforeLast('/', ""); load() })
        entries.forEach { e ->
            val name = e.str("name") ?: return@forEach
            val dir = e.str("type") == "directory"
            val child = if (path.isEmpty()) name else "$path/$name"
            rows.add(Hk.row(ctx, if (dir) "folder" else "file", name, if (dir) null else e.num("size")?.let { HomeModel.sizeText(it) }, if (dir) null else "you") {
                if (dir) { path = child; load() } else env.nav.go("file", "$bodyId$SEP$child")
            })
        }
        if (entries.isEmpty()) rows.add(Hk.row(ctx, null, "此目录为空"))
        addView(AshUi.group(ctx, path.substringAfterLast('/').ifEmpty { null }, rows = rows))
        if (l.optBoolean("truncated")) addView(Hk.note(ctx, "只显示了前面一部分"))
    }
}

/** One file: text and images are shown here, anything else can be saved to the phone. */
class HmFile(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    private val bodyId = arg?.substringBefore(SEP) ?: MAIN
    private val path = arg?.substringAfter(SEP, "") ?: ""
    override val title = path.substringAfterLast('/').ifEmpty { "文件" }
    private val note = Hk.note(ctx, "正在读取…")
    private val holder = AshUi.vstack(ctx, 14)
    private var data: ByteArray? = null
    private var mime = ""

    init {
        val actions = AshUi.hstack(ctx, 8).apply {
            addView(AshUi.button(ctx, "所在文件夹", Kind.NEUTRAL, AshUi.BtnSize.SM) { env.nav.go("files", "dir:$bodyId$SEP${path.substringBeforeLast('/', "")}") })
            addView(AshUi.button(ctx, "下载", Kind.NEUTRAL, AshUi.BtnSize.SM) { download() })
        }
        body.addView(actions); body.addView(note); body.addView(holder)
    }

    private fun ext() = path.substringAfterLast('.', "").lowercase()

    private fun fetch(done: (ByteArray, String) -> Unit) {
        data?.let { done(it, mime); return }
        call(bodyId, "workspace.read", JSONObject().put("path", path).put("limit", 100_000)) { r ->
            if (!r.ok) { note.text = r.failure?.message ?: "文件无法读取"; return@call }
            val content = r.result?.optJSONArray("content")?.objects() ?: emptyList()
            val resource = content.firstOrNull { it.str("type") == "resource" }
            val image = content.firstOrNull { it.str("type") == "image" }
            val text = r.data.str("text")
            fun got(bytes: ByteArray, m: String) { if (bytes.size > 20 * 1024 * 1024) { note.text = "文件超过当前 20 MiB 的限制"; return }; data = bytes; mime = m; done(bytes, m) }
            when {
                resource?.str("stream") != null -> env.port.stream(resource.str("stream")!!) { m, bytes, f -> if (alive) { if (bytes == null) note.text = f?.message ?: "文件无法读取" else got(bytes, m ?: resource.str("mime") ?: "application/octet-stream") } }
                image != null -> got(Base64.decode(image.str("b64") ?: "", Base64.DEFAULT), image.str("mime") ?: "image/${ext()}")
                text != null -> got(text.toByteArray(), "text/plain")
                else -> note.text = "文件无法读取"
            }
        }
    }

    override fun refresh() {
        val e = ext()
        if (e !in HomeModel.IMAGES && e !in HomeModel.TEXTS) { note.text = "这种格式暂未接入内置阅读器，请下载后打开。"; return }
        fetch { bytes, _ ->
            holder.removeAllViews(); note.text = ""
            if (e in HomeModel.IMAGES) {
                val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
                val sample = generateSequence(1) { it * 2 }.first { opts.outWidth / it <= 2048 && opts.outHeight / it <= 2048 }
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                if (bmp == null) note.text = "图片无法打开" else holder.addView(ImageView(ctx).apply { setImageBitmap(bmp); adjustViewBounds = true; scaleType = ImageView.ScaleType.FIT_CENTER; contentDescription = path }, LinearLayout.LayoutParams(-1, -2))
            } else {
                if (e == "html" || e == "htm") note.text = "网页阅读模式（不运行脚本，不加载其中的图片和样式表）"
                holder.addView(Hk.pre(ctx, String(bytes)))
            }
        }
    }

    private fun download() {
        note.text = "正在保存…"
        fetch { bytes, m ->
            val name = path.substringAfterLast('/')
            Thread {
                val result = runCatching {
                    val type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext()) ?: m
                    if (Build.VERSION.SDK_INT >= 29) {
                        val values = ContentValues().apply { put(MediaStore.Downloads.DISPLAY_NAME, name); put(MediaStore.Downloads.MIME_TYPE, type) }
                        val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("no uri")
                        ctx.contentResolver.openOutputStream(uri)!!.use { it.write(bytes) }
                        "下载"
                    } else {
                        val dir = ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)!!.also { it.mkdirs() }
                        File(dir, name).writeBytes(bytes); dir.path
                    }
                }
                ctx.runOnUiThread { if (alive) note.text = result.fold({ "文件已保存到「$it」" }, { "保存失败" }) }
            }.start()
        }
    }
}
