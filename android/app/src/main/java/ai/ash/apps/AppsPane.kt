package ai.ash.apps

import ai.ash.R

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Bitmap
import android.graphics.Typeface
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * The 「应用」 tab of Ash: the owner's apps as Ash lists them. Tap to open one in its own task (in the isolated process,
 * as before); long-press to add it to the home screen. It lives in Ash's own process, so the list comes straight from
 * Ash ([Ash] with `inProcess`) and the pages of the apps stay where they were. [view] goes into the home screen's content
 * area (which already keeps clear of the system bars and the keyboard); call [refresh] whenever it is shown; [close] when
 * the screen goes. [toChat] switches to the chat tab.
 */
class AppsPane(private val activity: Activity, private val ash: Ash, private val toChat: () -> Unit) {
    private val list: LinearLayout
    private val status: TextView
    private val retry: Button
    private val icons: MutableMap<String, Bitmap?> = java.util.Collections.synchronizedMap(HashMap())
    @Volatile private var loading = false
    @Volatile private var closed = false
    val view: View

    init {
        val d = { v: Int -> Ui.dp(activity, v) }
        val column = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(d(20), d(16), d(20), d(20)) }
        column.addView(TextView(activity).apply { text = "应用"; textSize = 24f; typeface = Typeface.DEFAULT_BOLD; setTextColor(Ui.text(activity)) })
        column.addView(TextView(activity).apply {
            text = "你的应用，每个都有自己的页面。长按可以添加到桌面。"
            textSize = 14f; setTextColor(Ui.muted(activity)); setPadding(0, d(6), 0, d(12))
        })
        status = TextView(activity).apply { textSize = 15f; setTextColor(Ui.muted(activity)); setPadding(0, d(12), 0, d(8)) }
        column.addView(status)
        retry = Button(activity).apply { text = "重试"; visibility = View.GONE; setOnClickListener { refresh() } }
        column.addView(retry, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        list = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        column.addView(list)
        view = ScrollView(activity).apply { addView(column); setBackgroundColor(Ui.page(activity)) }
    }

    fun close() { closed = true; ash.close() }

    fun refresh() {
        if (loading || closed) return
        loading = true
        if (list.childCount == 0) status.text = "正在向 Ash 要应用列表…"
        Thread({
            val result = runCatching { ash.apps() }
            result.getOrNull()?.forEach { a -> if (!icons.containsKey(a.id)) icons[a.id] = ash.icon(a.id) }
            activity.runOnUiThread {
                loading = false
                if (closed || activity.isDestroyed) return@runOnUiThread
                result.onSuccess { show(it) }.onFailure {
                    list.removeAllViews()
                    status.text = it.message ?: "连不上 Ash"
                    status.visibility = View.VISIBLE
                    retry.visibility = View.VISIBLE
                }
            }
        }, "apps-list").start()
    }

    private fun show(apps: List<AppInfo>) {
        retry.visibility = View.GONE
        status.visibility = if (apps.isEmpty()) View.VISIBLE else View.GONE
        status.text = "还没有应用。在 Ash 里装好、批准的应用会出现在这里。"
        list.removeAllViews()
        for (a in apps) list.addView(row(a))
    }

    private fun row(a: AppInfo): View {
        val d = { v: Int -> Ui.dp(activity, v) }
        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, d(12), 0, d(12))
            isClickable = true; isLongClickable = true
            setBackgroundResource(android.R.drawable.list_selector_background)
        }
        row.addView(ImageView(activity).apply {
            val b = icons[a.id]
            if (b != null) setImageBitmap(b) else setImageResource(R.drawable.ic_launcher)
            scaleType = ImageView.ScaleType.FIT_CENTER
        }, LinearLayout.LayoutParams(d(48), d(48)))
        val text = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(d(14), 0, 0, 0) }
        text.addView(TextView(activity).apply { this.text = a.name; textSize = 17f; typeface = Typeface.DEFAULT_BOLD; setTextColor(Ui.text(activity)) })
        if (a.summary.isNotBlank()) text.addView(TextView(activity).apply {
            this.text = a.summary; textSize = 13f; maxLines = 2; ellipsize = TextUtils.TruncateAt.END; setTextColor(Ui.muted(activity))
        })
        if (!a.usable) text.addView(TextView(activity).apply {
            this.text = if (!a.enabled) "已在 Ash 里停用" else "等你在 Ash 里批准"; textSize = 13f; setTextColor(Ui.ACCENT)
        })
        row.addView(text, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        row.setOnClickListener { open(a) }
        row.setOnLongClickListener {
            AlertDialog.Builder(activity).setTitle(a.name).setItems(arrayOf("打开", "添加到桌面")) { _, which ->
                if (which == 0) open(a) else Pin.request(activity, a.id, a.name, icons[a.id])
            }.show()
            true
        }
        return row
    }

    private fun open(a: AppInfo) {
        if (a.usable) { activity.startActivity(Ui.appIntent(activity, a.id)); return }
        AlertDialog.Builder(activity)
            .setTitle("「${a.name}」还不能用")
            .setMessage(if (!a.enabled) "它已在 Ash 里停用。到 Ash 的「设置 › 应用」里重新启用后可用。" else "到 Ash 的「设置 › 应用」里安装，或让 Ash 帮你装，批准后可用。")
            .setPositiveButton("回到对话") { _, _ -> toChat() }
            .setNegativeButton("取消", null)
            .show()
    }
}
