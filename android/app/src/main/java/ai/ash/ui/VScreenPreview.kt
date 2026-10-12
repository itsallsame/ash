package ai.ash.ui

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import ai.ash.human.HumanSend
import ai.ash.link.Link
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger

/**
 * A small floating window that shows the virtual screen live while it exists, so the owner can
 * watch what Ash does there. The app holds no high-privilege channel: frames are the kernel's
 * `service:host` `vscreen.see` (downscaled JPEG, ~4 fps), asked for as the owner over the app's one
 * connection to the kernel, on a worker thread (a read of the owner's, so it is not written to the
 * ledger). The window itself is only touched on the main thread.
 *
 * The kernel tells when the virtual screen is made or closed ([screenState]); the window comes and goes
 * with it. Draggable, pinch to resize, ✕ hides it (the virtual screen keeps running). Polling stops while
 * the window is hidden or the screen is off. If the virtual screen goes away or the answers keep failing,
 * the window disappears. While frames are being watched the kernel is told ([watching], presence), which
 * is use, not idling. Nothing here may crash the app: every failure just hides the window.
 */
object VScreenPreview {
    private const val TAG = "ash.preview"
    private const val FRAME_MS = 250L
    private const val QUALITY = 60
    /** Asks in a row that never reached the kernel (no connection) before the window is taken down. */
    private const val MAX_LOST = 30
    /** Longest wait between asks while the screen has no frame to show (a fresh, blank virtual screen): each failed ask is an error the health check counts. */
    private const val SLOW_MS = 5000L

    enum class Shown { OK, NO_SCREEN, NO_PERMISSION }

    private val main = Handler(Looper.getMainLooper())
    private val worker: Handler by lazy { Handler(HandlerThread("ash-vscreen-preview").apply { start() }.looper) }

    // Main-thread state.
    private var app: Context? = null
    private var root: FrameLayout? = null
    private var image: ImageView? = null
    private var lp: WindowManager.LayoutParams? = null
    private var screenReceiver: BroadcastReceiver? = null
    /** Window width in px (kept across hide/show); height follows the virtual screen's aspect. */
    private var widthPx = 0
    private var aspect = 16f / 9f

    /** The owner is looking at the live frames now (window up, screen on): told to the kernel as presence. */
    @Volatile var watching = false; private set

    /** Bumped to stop the current polling loop (hide, screen off). Read on the worker. */
    private val loop = AtomicInteger()
    @Volatile private var maxSide = 480

    /**
     * Shows the window if a virtual screen exists and ash may draw overlays; [done] hears how it went (on the main thread).
     * Safe from any thread: whether a screen exists is asked of the kernel on the worker.
     */
    fun show(ctx: Context, done: (Shown) -> Unit = {}) {
        val c = ctx.applicationContext
        worker.post {
            val shown = when {
                !exists(c) -> Shown.NO_SCREEN
                !canDraw(c) -> Shown.NO_PERMISSION
                else -> { main.post { safely { attach(c) } }; Shown.OK }
            }
            main.post { done(shown) }
        }
    }

    /** The kernel said the virtual screen was made ([open]) or closed. A screen that is made brings the window up (if ash may draw), one that is closed takes it down. */
    fun screenState(ctx: Context, open: Boolean) {
        val c = ctx.applicationContext
        if (!open) { hide(); return }
        if (canDraw(c)) main.post { safely { attach(c) } }
    }

    /** The connection to the kernel opened: a virtual screen may already be there (made while the app was not connected). */
    fun sync(ctx: Context) {
        val c = ctx.applicationContext
        worker.post { if (exists(c) && canDraw(c)) main.post { safely { attach(c) } } }
    }

    /** Removes the window and stops polling (the virtual screen itself is untouched). Safe from any thread. */
    fun hide() {
        loop.incrementAndGet()
        main.post { safely { detach() } }
    }

    /** Whether the kernel has a virtual screen now (`vscreen.status`, a read of the owner's); false when it cannot say. Worker thread. */
    private fun exists(c: Context): Boolean = try {
        val sent = HumanSend.send(Link.get(c).client, ask("vscreen.status", JSONObject()))
        HumanSend.data(sent)?.optBoolean("running") == true
    } catch (e: Throwable) { false }

    private fun ask(word: String, body: JSONObject) =
        JSONObject().put("to", "service:host").put("kind", "request").put("word", word).put("body", body).put("wait", true)

    /** Tells the kernel whether frames are being watched (presence), only when that changed. */
    private fun setWatching(c: Context, on: Boolean) {
        if (watching == on) return
        watching = on
        try { Link.get(c).presence.tell() } catch (e: Throwable) { Log.w(TAG, "presence", e) }
    }

    private fun canDraw(c: Context) = Build.VERSION.SDK_INT < 23 || try { Settings.canDrawOverlays(c) } catch (e: Throwable) { false }

    private inline fun safely(block: () -> Unit) {
        try { block() } catch (e: Throwable) {
            Log.w(TAG, "preview window failed", e)
            try { detach() } catch (_: Throwable) {}
        }
    }

    // ───────────────────────────── window (main thread) ─────────────────────────────

    @SuppressLint("ClickableViewAccessibility")
    private fun attach(c: Context) {
        if (root != null) return startLoop()
        if (!canDraw(c)) return
        app = c
        val dm = c.resources.displayMetrics
        val density = dm.density
        fun dp(v: Int) = (v * density).toInt()
        if (widthPx == 0) widthPx = (minOf(dm.widthPixels, dm.heightPixels) * 0.3f).toInt()
        widthPx = clampWidth(c, widthPx)

        val img = ImageView(c).apply { scaleType = ImageView.ScaleType.FIT_XY; setBackgroundColor(Color.BLACK) }
        val label = TextView(c).apply {
            text = "Ash 虚拟屏"; textSize = 10f; setTextColor(Color.WHITE)
            setPadding(dp(6), dp(2), dp(6), dp(2))
            background = GradientDrawable().apply { cornerRadius = dp(8).toFloat(); setColor(0x80000000.toInt()) }
        }
        val close = TextView(c).apply {
            text = "✕"; textSize = 13f; setTextColor(Color.WHITE); gravity = Gravity.CENTER
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0x99000000.toInt()) }
            contentDescription = "隐藏虚拟屏预览"
            setOnClickListener { hide() }
        }
        val frame = FrameLayout(c).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat(); setColor(Color.BLACK); setStroke(dp(1), 0x66FFFFFF)
            }
            outlineProvider = ViewOutlineProvider.BACKGROUND
            clipToOutline = true
            elevation = dp(6).toFloat()
            addView(img, FrameLayout.LayoutParams(-1, -1))
            addView(label, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.START).apply { setMargins(dp(4), dp(4), 0, 0) })
            addView(close, FrameLayout.LayoutParams(dp(24), dp(24), Gravity.TOP or Gravity.END).apply { setMargins(0, dp(4), dp(4), 0) })
        }

        @Suppress("DEPRECATION")
        val type = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE
        val params = WindowManager.LayoutParams(
            widthPx, heightFor(widthPx), type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = dm.widthPixels - widthPx - dp(12)
            y = dp(72)
        }
        wm(c).addView(frame, params)
        root = frame; image = img; lp = params
        maxSide = maxOf(params.width, params.height).coerceIn(160, 720)
        frame.setOnTouchListener(DragResize(c))
        registerScreen(c)
        startLoop()
    }

    private fun detach() {
        loop.incrementAndGet()
        val c = app
        val r = root
        root = null; image = null; lp = null
        if (c != null) {
            setWatching(c, false)
            screenReceiver?.let { try { c.unregisterReceiver(it) } catch (_: Throwable) {} }
            screenReceiver = null
            if (r != null) try { wm(c).removeViewImmediate(r) } catch (_: Throwable) {}
        }
    }

    private fun wm(c: Context) = c.getSystemService(Context.WINDOW_SERVICE) as WindowManager

    private fun heightFor(w: Int) = (w * aspect).toInt()

    private fun clampWidth(c: Context, w: Int): Int {
        val dm = c.resources.displayMetrics
        val min = (80 * dm.density).toInt()
        // Tall enough to fit on screen, never wider than most of the short side.
        val max = minOf((minOf(dm.widthPixels, dm.heightPixels) * 0.8f).toInt(), (dm.heightPixels * 0.8f / aspect).toInt())
        return w.coerceIn(min, maxOf(min, max))
    }

    /** Applies size/position changes, keeping the window on screen. */
    private fun relayout() {
        val c = app ?: return
        val r = root ?: return
        val p = lp ?: return
        val dm = c.resources.displayMetrics
        widthPx = clampWidth(c, widthPx)
        p.width = widthPx
        p.height = heightFor(widthPx)
        p.x = p.x.coerceIn(0, maxOf(0, dm.widthPixels - p.width))
        p.y = p.y.coerceIn(0, maxOf(0, dm.heightPixels - p.height))
        maxSide = (maxOf(p.width, p.height)).coerceIn(160, 720)
        try { wm(c).updateViewLayout(r, p) } catch (e: Throwable) { Log.w(TAG, "relayout", e) }
    }

    private fun onFrame(bmp: Bitmap) {
        val img = image ?: return
        val a = bmp.height.toFloat() / bmp.width
        img.setImageBitmap(bmp)
        if (kotlin.math.abs(a - aspect) > 0.01f) {
            aspect = a
            relayout()
        }
    }

    /** One finger drags, two fingers pinch to resize. */
    private class DragResize(c: Context) : View.OnTouchListener {
        private var downX = 0f
        private var downY = 0f
        private var startX = 0
        private var startY = 0
        private var dragging = false
        private var scaling = false
        private val scale = ScaleGestureDetector(c, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScaleBegin(d: ScaleGestureDetector): Boolean { scaling = true; return true }
            override fun onScale(d: ScaleGestureDetector): Boolean {
                widthPx = (widthPx * d.scaleFactor).toInt()
                relayout()
                return true
            }
        })

        override fun onTouch(v: View, e: MotionEvent): Boolean {
            val p = lp ?: return false
            scale.onTouchEvent(e)
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX; downY = e.rawY; startX = p.x; startY = p.y
                    dragging = false; scaling = false
                }
                MotionEvent.ACTION_MOVE -> if (!scaling && e.pointerCount == 1) {
                    val dx = e.rawX - downX
                    val dy = e.rawY - downY
                    if (dragging || dx * dx + dy * dy > 64f) {
                        dragging = true
                        p.x = startX + dx.toInt(); p.y = startY + dy.toInt()
                        relayout()
                    }
                }
                MotionEvent.ACTION_POINTER_UP -> {
                    // Re-anchor the drag after a pinch so the window does not jump.
                    val rest = if (e.actionIndex == 0) 1 else 0
                    downX = e.getRawXCompat(rest); downY = e.getRawYCompat(rest); startX = p.x; startY = p.y
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { dragging = false; scaling = false }
            }
            return true
        }

        private fun MotionEvent.getRawXCompat(i: Int) = if (Build.VERSION.SDK_INT >= 29) getRawX(i) else rawX - getX(0) + getX(i)
        private fun MotionEvent.getRawYCompat(i: Int) = if (Build.VERSION.SDK_INT >= 29) getRawY(i) else rawY - getY(0) + getY(i)
    }

    /** Screen off → stop polling; screen on → resume (while the window is shown). */
    private fun registerScreen(c: Context) {
        if (screenReceiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                if (intent.action == Intent.ACTION_SCREEN_OFF) { loop.incrementAndGet(); setWatching(ctx, false) } else if (root != null) startLoop()
            }
        }
        c.registerReceiver(r, IntentFilter().apply { addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_SCREEN_ON) })
        screenReceiver = r
    }

    // ───────────────────────────── frames (worker thread) ─────────────────────────────

    private fun startLoop() {
        val c = app ?: return
        val gen = loop.incrementAndGet()
        setWatching(c, true)
        worker.post { poll(c, gen, 0, 0) }
    }

    private fun poll(c: Context, gen: Int, failures: Int, lostBefore: Int) {
        if (gen != loop.get()) return
        val interactive = try { (c.getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive } catch (e: Throwable) { true }
        if (!interactive) return // the SCREEN_ON receiver starts a new loop
        val t0 = SystemClock.uptimeMillis()
        var fails = failures
        var lost = lostBefore
        try {
            val body = JSONObject().put("max_side", maxSide).put("quality", QUALITY)
            val bytes = frame(HumanSend.send(Link.get(c).client, ask("vscreen.see", body)))
            if (gen != loop.get()) return
            val bmp = bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            if (bmp != null) { main.post { if (gen == loop.get()) safely { onFrame(bmp) } }; fails = 0; lost = 0 } else fails++
        } catch (e: HumanSend.Refused) {
            // The virtual screen is gone (closed, or the host lost it): the preview has nothing left to show.
            if (e.message.orEmpty().contains("no virtual screen") || e.code == "unavailable" || e.code == "forbidden" || e.code == "not_found") {
                Log.i(TAG, "virtual screen gone, hiding preview: ${e.code} ${e.message}")
                if (gen == loop.get()) hide()
                return
            }
            fails++; lost = 0 // e.g. no frame rendered yet (a fresh, blank screen), or a slow answer: keep trying, slower
        } catch (e: IOException) {
            fails++; lost++ // not connected right now
        } catch (e: Throwable) {
            Log.w(TAG, "frame", e)
            fails++; lost++
        }
        if (lost >= MAX_LOST) { Log.i(TAG, "the kernel does not answer, hiding preview"); if (gen == loop.get()) hide(); return }
        val delay = if (fails == 0) maxOf(0L, FRAME_MS - (SystemClock.uptimeMillis() - t0)) else minOf(SLOW_MS, 2 * FRAME_MS * fails)
        worker.postDelayed({ poll(c, gen, fails, lost) }, delay)
    }

    /** The JPEG in the answer to `vscreen.see` (its image part), or null when there is none. */
    private fun frame(sent: JSONObject): ByteArray? {
        val parts = HumanSend.reply(sent)?.optJSONObject("result")?.optJSONArray("content") ?: return null
        for (i in 0 until parts.length()) {
            val part = parts.optJSONObject(i) ?: continue
            if (part.optString("type") == "image") return part.optString("b64").takeIf { it.isNotEmpty() }?.let { Base64.decode(it, Base64.DEFAULT) }
        }
        return null
    }
}
