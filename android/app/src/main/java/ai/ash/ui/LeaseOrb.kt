package ai.ash.ui

import ai.ash.host.TaskStatus
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The small floating ball that stays over other apps while the owner has lent the screen: the time left and who is operating. It can
 * be dragged; a tap opens it into what the agent is doing now and a 「收回权限」 button; another tap closes it again. It goes away
 * by itself when the lease ends. Like the virtual screen's preview it is one overlay window, touched only on the main thread, and
 * nothing here may crash the app: any failure just takes the ball down.
 */
object LeaseOrb {
    private const val TAG = "ash.lease.orb"
    private val AMBER = 0xFFFFB020.toInt()
    private val RED = 0xFFFF5A4F.toInt()
    private val main = Handler(Looper.getMainLooper())

    private var app: Context? = null
    private var root: FrameLayout? = null
    private var lp: WindowManager.LayoutParams? = null
    private var leases: List<LeaseState.Lease> = emptyList()
    private var open = false
    private var posX = -1
    private var posY = -1
    /** What the views drawn now were made from; while it holds only their text changes, so a tap on the button is never cut by a redraw. */
    private var built = ""
    private var timeView: TextView? = null
    private var statusView: TextView? = null
    private var doingView: TextView? = null

    /** Shows the ball, or brings what it says up to date. Main thread. */
    fun show(ctx: Context, live: List<LeaseState.Lease>) {
        val c = ctx.applicationContext
        leases = live
        try {
            if (root == null) attach(c)
            paint()
        } catch (e: Throwable) { Log.w(TAG, "orb failed", e); hide() }
    }

    fun hide() {
        val c = app ?: return
        val r = root
        root = null; lp = null; open = false; built = ""
        if (r != null) try { wm(c).removeViewImmediate(r) } catch (_: Throwable) {}
    }

    private fun wm(c: Context) = c.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private fun dp(c: Context, v: Int) = (v * c.resources.displayMetrics.density).toInt()

    @SuppressLint("ClickableViewAccessibility")
    private fun attach(c: Context) {
        app = c
        val frame = FrameLayout(c)
        @Suppress("DEPRECATION")
        val type = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE
        val dm = c.resources.displayMetrics
        val params = WindowManager.LayoutParams(-2, -2, type, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.START
            if (posX < 0) { posX = dm.widthPixels - dp(c, 76); posY = dp(c, 140) }
            x = posX; y = posY
        }
        wm(c).addView(frame, params)
        root = frame; lp = params
        frame.setOnTouchListener(Drag(c))
    }

    /** One finger drags; a tap (no move) opens or closes. The buttons inside the opened card take their own taps. */
    private class Drag(private val c: Context) : View.OnTouchListener {
        private var downX = 0f; private var downY = 0f; private var startX = 0; private var startY = 0; private var moved = false
        override fun onTouch(v: View, e: MotionEvent): Boolean {
            val p = lp ?: return false
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { downX = e.rawX; downY = e.rawY; startX = p.x; startY = p.y; moved = false }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (moved || dx * dx + dy * dy > 64f) {
                        moved = true
                        val dm = c.resources.displayMetrics
                        p.x = (startX + dx.toInt()).coerceIn(0, maxOf(0, dm.widthPixels - v.width)); p.y = (startY + dy.toInt()).coerceIn(0, maxOf(0, dm.heightPixels - v.height))
                        posX = p.x; posY = p.y
                        try { wm(c).updateViewLayout(root, p) } catch (_: Throwable) {}
                    }
                }
                MotionEvent.ACTION_UP -> if (!moved) { open = !open; paint() }
            }
            return true
        }
    }

    private fun label(c: Context, text: String, sp: Float, color: Int, bold: Boolean = false) = TextView(c).apply {
        this.text = text; setTextSize(TypedValue.COMPLEX_UNIT_SP, sp); setTextColor(color); gravity = Gravity.CENTER
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    /** Redraws the ball or the opened card from what the hub last said; called every second by [LeaseState]. */
    private fun paint() {
        val c = app ?: return
        val r = root ?: return
        val first = leases.firstOrNull() ?: return
        val now = System.currentTimeMillis()
        val urgent = first.remaining(now) <= 60_000
        val ring = if (urgent) RED else AMBER
        val key = "$open|${first.id}|${leases.size}|$urgent"
        if (key == built) {
            if (!open) timeView?.text = first.clock(now)
            else {
                statusView?.text = "授权剩余 ${first.clock(now)}" + if (leases.size > 1) "（共 ${leases.size} 项）" else ""
                val doing = TaskStatus.activity().take(3)
                doingView?.text = if (doing.isEmpty()) "此刻没有在做事" else doing.joinToString("\n")
            }
            return
        }
        built = key
        r.removeAllViews()
        // The opened card is wider than the ball: it slides left to stay on the screen, and the ball goes back where it was.
        lp?.let { p ->
            p.x = if (open) minOf(posX, maxOf(0, c.resources.displayMetrics.widthPixels - dp(c, 238))) else posX
            try { wm(c).updateViewLayout(r, p) } catch (_: Throwable) {}
        }
        if (!open) {
            val ball = LinearLayout(c).apply {
                orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xE61C1C1E.toInt()); setStroke(dp(c, 3), ring) }
                timeView = label(c, first.clock(now), 13f, Color.WHITE, bold = true)
                addView(timeView)
                addView(label(c, first.name.take(6), 9f, 0xFFD0D0D0.toInt()))
                contentDescription = "屏幕授权：${first.name} 剩 ${first.clock(now)}，点开看看"
            }
            r.addView(ball, FrameLayout.LayoutParams(dp(c, 60), dp(c, 60)))
        } else {
            val card = LinearLayout(c).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(c, 14), dp(c, 12), dp(c, 14), dp(c, 12))
                background = GradientDrawable().apply { cornerRadius = dp(c, 16).toFloat(); setColor(0xF01C1C1E.toInt()); setStroke(dp(c, 2), ring) }
                addView(label(c, "${first.name} 正在操作你的手机", 14f, Color.WHITE, bold = true).apply { gravity = Gravity.START })
                statusView = label(c, "授权剩余 ${first.clock(now)}" + if (leases.size > 1) "（共 ${leases.size} 项）" else "",
                    12f, ring).apply { gravity = Gravity.START }
                addView(statusView)
                val doing = TaskStatus.activity().take(3)
                doingView = label(c, if (doing.isEmpty()) "此刻没有在做事" else doing.joinToString("\n"), 12f, 0xFFD0D0D0.toInt()).apply {
                    gravity = Gravity.START; setPadding(0, dp(c, 8), 0, dp(c, 10)); maxLines = 4
                }
                addView(doingView)
                addView(label(c, "收回权限", 14f, Color.WHITE, bold = true).apply {
                    setPadding(dp(c, 10), dp(c, 8), dp(c, 10), dp(c, 8))
                    background = GradientDrawable().apply { cornerRadius = dp(c, 10).toFloat(); setColor(RED) }
                    isClickable = true; contentDescription = "收回屏幕权限"
                    setOnClickListener { LeaseState.revoke(c); open = false }
                })
            }
            r.addView(card, FrameLayout.LayoutParams(dp(c, 230), -2))
        }
    }
}
