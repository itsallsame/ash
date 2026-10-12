package ai.ash.kernel

import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 「Ash 内核」: the kernel's one screen, with a launcher icon and a task of its own, so that it has a card in recent apps
 * the owner can lock (the maker's cleaning then leaves the kernel alone, as it does for any locked app). It shows how the
 * brain is doing and how to lock it, and starts the kernel service like [StartActivity] does. It reads nothing from the
 * intent that opened it.
 */
class StatusActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var state: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try { KernelService.start(this) } catch (_: Exception) { /* the screen still says what it can */ }
        val pad = dp(24)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(pad, dp(72), pad, pad)
        }
        root.addView(text("Ash 内核", 26f, bold = true))
        state = text("", 16f).also { it.setPadding(0, dp(16), 0, 0) }
        root.addView(state)
        root.addView(text(LOCK_HINT, 15f).also { it.setPadding(0, dp(32), 0, 0) })
        root.addView(Button(this).apply {
            text = "打开 Ash"
            setOnClickListener { packageManager.getLaunchIntentForPackage(HAND_PACKAGE)?.let { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(32) })
        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    override fun onPause() {
        main.removeCallbacksAndMessages(null)
        super.onPause()
    }

    private fun refresh() {
        state.text = "大脑：" + (KernelService.status ?: KernelText.STARTING)
        main.postDelayed(::refresh, 2_000)
    }

    private fun text(s: String, sp: Float, bold: Boolean = false) = TextView(this).apply {
        text = s
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        gravity = Gravity.CENTER_HORIZONTAL
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val HAND_PACKAGE = "ai.ash.agent"
        const val LOCK_HINT = "这是 Ash 的大脑。打开最近任务，把「Ash 内核」这张卡片锁住，系统清理后台时就会留下她的大脑。"
    }
}
