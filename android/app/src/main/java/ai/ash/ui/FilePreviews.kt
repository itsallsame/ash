package ai.ash.ui

import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.Role
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TableLayout
import android.widget.TableRow
import android.widget.VideoView
import java.io.File
import java.util.concurrent.Executors

/** The views of the file viewer that are more than text: a table, a PDF, a sound, a video. Players and the PDF read a file in the app's cache. */
internal object FilePreviews {
    /** A view that plays, and what to call when the viewer lets go of it. */
    class Playing(val view: View, val release: () -> Unit)

    /** A table of at most a few hundred rows; the first row is the heading. The table scrolls sideways. */
    fun table(ctx: Context, table: FileFormats.Table): View {
        val c = AshUi.p(ctx)
        val padX = AshUi.dp(ctx, 10); val padY = AshUi.dp(ctx, 6); val maxW = AshUi.dp(ctx, 220)
        val grid = TableLayout(ctx)
        table.rows.forEachIndexed { r, cells ->
            val row = TableRow(ctx)
            if (r == 0) row.setBackgroundColor(c.surface2)
            for (cell in cells) row.addView(AshUi.text(ctx, cell, if (r == 0) AshType(14f, 21f, 650, Role.INK) else AshTokens.Type.callout, maxLines = 1).apply {
                setPadding(padX, padY, padX, padY); maxWidth = maxW; ellipsize = TextUtils.TruncateAt.END
            })
            grid.addView(row)
        }
        return HorizontalScrollView(ctx).apply { addView(grid) }
    }

    // ---------- sound and video ----------

    private interface Transport {
        fun start(); fun pause()
        val playing: Boolean
        val position: Int
        val duration: Int
        fun seek(ms: Int)
    }

    /** Play / pause, a bar to drag, and the time; it wakes up when the player is ready and ticks while it plays. */
    private class Controls(ctx: Context) {
        val view = AshUi.hstack(ctx, 10).apply { gravity = Gravity.CENTER_VERTICAL }
        private val button = AshUi.button(ctx, "播放", AshUi.Kind.SECONDARY, AshUi.BtnSize.SM).apply { isEnabled = false }
        private val bar = SeekBar(ctx)
        private val time = AshUi.text(ctx, "0:00", AshTokens.Type.sub)
        private val main = Handler(Looper.getMainLooper())
        private var transport: Transport? = null
        private val tick = object : Runnable { override fun run() { update(); main.postDelayed(this, 400) } }

        init {
            view.addView(button); view.addView(bar, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)); view.addView(time)
            button.setOnClickListener { transport?.let { if (it.playing) it.pause() else it.start(); update() } }
            bar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(b: SeekBar, progress: Int, fromUser: Boolean) { if (fromUser) transport?.seek(progress) }
                override fun onStartTrackingTouch(b: SeekBar) {}
                override fun onStopTrackingTouch(b: SeekBar) {}
            })
        }

        fun ready(t: Transport) { transport = t; bar.max = maxOf(t.duration, 1); button.isEnabled = true; main.post(tick) }
        fun stop() { main.removeCallbacks(tick) }
        private fun update() {
            val t = transport ?: return
            bar.progress = t.position; button.text = if (t.playing) "暂停" else "播放"; time.text = "${clock(t.position)} / ${clock(t.duration)}"
        }
        private fun clock(ms: Int) = "%d:%02d".format(ms / 60000, ms / 1000 % 60)
    }

    fun audio(ctx: Context, file: File, onFail: () -> Unit): Playing {
        val controls = Controls(ctx)
        val player = MediaPlayer()
        val transport = object : Transport {
            override fun start() = player.start()
            override fun pause() = player.pause()
            override val playing get() = player.isPlaying
            override val position get() = player.currentPosition
            override val duration get() = player.duration
            override fun seek(ms: Int) = player.seekTo(ms)
        }
        try {
            player.setDataSource(file.path)
            player.setOnPreparedListener { controls.ready(transport) }
            player.setOnErrorListener { _, _, _ -> onFail(); true }
            player.prepareAsync()
        } catch (e: Exception) { onFail() }
        return Playing(controls.view) { controls.stop(); runCatching { player.release() } }
    }

    fun video(ctx: Context, file: File, onFail: () -> Unit): Playing {
        val controls = Controls(ctx)
        val screen = ctx.resources.displayMetrics
        val width = screen.widthPixels - 2 * AshUi.dp(ctx, AshTokens.Space.pageX)
        val view = VideoView(ctx)
        val transport = object : Transport {
            override fun start() = view.start()
            override fun pause() = view.pause()
            override val playing get() = view.isPlaying
            override val position get() = view.currentPosition
            override val duration get() = view.duration
            override fun seek(ms: Int) = view.seekTo(ms)
        }
        val box = AshUi.vstack(ctx, 10)
        box.addView(view, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, width * 9 / 16))
        box.addView(controls.view)
        view.setOnPreparedListener { mp ->
            // The picture's own shape, but not taller than most of the screen.
            if (mp.videoWidth > 0 && mp.videoHeight > 0) view.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                minOf((width.toLong() * mp.videoHeight / mp.videoWidth).toInt(), screen.heightPixels * 3 / 5))
            controls.ready(transport)
        }
        view.setOnErrorListener { _, _, _ -> onFail(); true }
        view.setVideoPath(file.path)
        return Playing(box) { controls.stop(); view.stopPlayback() }
    }
}

/**
 * The pages of a PDF in a column, drawn as they come near the screen and let go of when they are far from it, so a long document
 * holds only a few pictures. Pages are drawn as wide as the screen. [PdfRenderer] takes one call at a time: all of them go through one thread.
 * [onFail] is called when the file cannot be opened (damaged, or locked with a password).
 */
internal class PdfPages(private val ctx: Context, private val file: File, private val scroll: ScrollView, private val onFail: () -> Unit) {
    val view = AshUi.vstack(ctx, 8)
    private val main = Handler(Looper.getMainLooper())
    private val work = Executors.newSingleThreadExecutor()
    private val width = ctx.resources.displayMetrics.widthPixels - 2 * AshUi.dp(ctx, AshTokens.Space.pageX)
    private var renderer: PdfRenderer? = null
    private var closed = false
    private val pages = ArrayList<Page>()

    private class Page(val view: ImageView) { var bitmap: Bitmap? = null; var wanted = false }

    init {
        work.execute {
            try {
                val opened = PdfRenderer(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY))
                renderer = opened
                val ratio = if (opened.pageCount == 0) 1.414f else opened.openPage(0).let { p -> (p.height / p.width.toFloat()).also { p.close() } }
                main.post { if (!closed) build(opened.pageCount, ratio) }
            } catch (e: Exception) { main.post { if (!closed) onFail() } }
        }
    }

    /** One empty white page per page of the document, as tall as the first one is; the real height is set when a page is drawn. */
    private fun build(count: Int, ratio: Float) {
        for (i in 0 until count) {
            val image = ImageView(ctx).apply { scaleType = ImageView.ScaleType.FIT_XY; setBackgroundColor(Color.WHITE); contentDescription = "第 ${i + 1} 页" }
            view.addView(image, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (width * ratio).toInt()))
            pages.add(Page(image))
        }
        scroll.setOnScrollChangeListener { _, _, _, _, _ -> refresh() }
        scroll.post { refresh() }
    }

    private fun refresh() {
        if (closed) return
        val h = scroll.height
        val y = scroll.scrollY
        for ((i, page) in pages.withIndex()) {
            val top = topOf(page.view)
            val bottom = top + page.view.height
            if (bottom > y - h / 2 && top < y + h + h / 2) draw(i, page)
            else if (bottom < y - 2 * h || top > y + 3 * h) drop(page)
        }
    }

    /** The page's top in the scrolled column. */
    private fun topOf(v: View): Int {
        val content = scroll.getChildAt(0)
        var y = 0
        var p: View = v
        while (p !== content) { y += p.top; p = p.parent as? View ?: break }
        return y
    }

    private fun draw(index: Int, page: Page) {
        if (page.wanted) return
        page.wanted = true
        work.execute {
            val r = renderer ?: return@execute
            try {
                val source = r.openPage(index)
                val height = (width * source.height / source.width.toFloat()).toInt().coerceIn(1, 8000)
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
                source.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                source.close()
                main.post {
                    if (closed || !page.wanted) { bitmap.recycle(); return@post }
                    page.bitmap = bitmap
                    page.view.setImageBitmap(bitmap)
                    page.view.layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height)
                }
            } catch (e: Exception) { main.post { page.wanted = false } }
        }
    }

    private fun drop(page: Page) {
        page.wanted = false
        val bitmap = page.bitmap ?: return
        page.bitmap = null
        page.view.setImageDrawable(null)
        bitmap.recycle()
    }

    fun release() {
        closed = true
        scroll.setOnScrollChangeListener(null)
        pages.forEach { drop(it) }
        work.execute { runCatching { renderer?.close() } }
        work.shutdown()
    }
}
