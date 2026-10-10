package ai.ash.ui

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import ai.ash.host.KernelLauncher
import ai.ash.link.Link
import ai.ash.caps.config.Permissions
import ai.ash.caps.senses.NotificationSenseSettings

/** Diagnostics: the kernel package and the link to it, the phone permissions ash can use. No business logic. */
class ConsoleActivity : Activity() {
    private lateinit var info: TextView
    private lateinit var perms: LinearLayout
    private lateinit var notificationState: TextView
    private lateinit var notificationToggle: Button
    private lateinit var recoveryState: TextView
    private lateinit var recoveryToggle: Button
    private lateinit var residentState: TextView
    private lateinit var residentToggle: Button
    private val ui = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        val night = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
        setTheme(if (night) ai.ash.R.style.Ash_Dark else ai.ash.R.style.Ash_Light)
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(40, 60, 40, 60) }
        fun h(t: String) = root.addView(TextView(this).apply { text = t; textSize = 17f; setTypeface(typeface, Typeface.BOLD); setPadding(0, 36, 0, 12) })
        fun row(vararg bs: Pair<String, () -> Unit>) = root.addView(LinearLayout(this).apply {
            for ((label, fn) in bs) addView(Button(context).apply { text = label; isAllCaps = false; setOnClickListener { fn() } })
        })

        h("Ash 诊断")
        info = TextView(this).apply { textSize = 13f; setTextIsSelectable(true) }
        root.addView(info)
        row("启动内核" to { startKernel(KernelLauncher.ACTION_START) }, "停止" to { startKernel(KernelLauncher.ACTION_STOP) }, "重启" to { startKernel(KernelLauncher.ACTION_RESTART) })

        h("手机权限（给 Ash 用的能力）")
        perms = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(perms)
        row("权限引导" to { startActivity(Intent(this, OnboardingActivity::class.java)) }, "显示虚拟屏预览" to { showPreview() })

        h("无障碍自动恢复")
        recoveryState = TextView(this).apply { textSize = 13f }
        root.addView(recoveryState)
        recoveryToggle = Button(this).apply {
            isAllCaps = false
            setOnClickListener {
                val ctx = this@ConsoleActivity
                ai.ash.caps.config.ScreenRecovery.setEnabled(ctx, !ai.ash.caps.config.ScreenRecovery.enabled(ctx)); renderRecovery()
            }
        }
        root.addView(recoveryToggle)

        h("灵动岛常驻入口")
        residentState = TextView(this).apply { textSize = 13f }
        root.addView(residentState)
        residentToggle = Button(this).apply {
            isAllCaps = false
            setOnClickListener { TaskCapsule.setResidentKept(this@ConsoleActivity, !TaskCapsule.residentKept(this@ConsoleActivity)); renderResident() }
        }
        root.addView(residentToggle)

        h("通知读取（可选，默认关闭）")
        notificationState = TextView(this).apply { textSize = 13f }
        root.addView(notificationState)
        notificationToggle = Button(this).apply {
            isAllCaps = false
            setOnClickListener {
                if (NotificationSenseSettings.enabled(this@ConsoleActivity)) {
                    if (!NotificationSenseSettings.setEnabled(this@ConsoleActivity, false)) Toast.makeText(context, "保存失败", Toast.LENGTH_SHORT).show()
                    renderNotificationSense()
                } else {
                    AlertDialog.Builder(this@ConsoleActivity)
                        .setTitle("开启通知读取？")
                        .setMessage("仅在你开启本开关并授予系统访问权后，Ash 才会读取新通知的应用、标题和正文并发送给本机服务。关闭本开关或撤销系统权限后停止；不会补读已有通知。")
                        .setNegativeButton("取消", null)
                        .setPositiveButton("继续") { _, _ ->
                            if (!NotificationSenseSettings.setEnabled(this@ConsoleActivity, true)) Toast.makeText(context, "保存失败", Toast.LENGTH_SHORT).show()
                            renderNotificationSense()
                            if (NotificationSenseSettings.enabled(this@ConsoleActivity) && !NotificationSenseSettings.granted(this@ConsoleActivity)) openNotificationAccess()
                        }.show()
                }
            }
        }
        root.addView(notificationToggle)
        row("系统读取权限" to { openNotificationAccess() })

        setContentView(ScrollView(this).apply { addView(root) })
        refresh()
    }

    private fun refresh() {
        if (isFinishing) return
        Thread {
            val kernel = KernelLauncher.installedVersion(this)
            val text = buildString {
                append("内核包：${kernel?.let { "已安装 $it" } ?: "未安装"}\n")
                append("内核连接：${Link.describe()}\n")
                append("App：${packageManager.getPackageInfo(packageName, 0).versionName}  Android ${Build.VERSION.RELEASE}（API ${Build.VERSION.SDK_INT}）")
            }
            ui.post { info.text = text; renderPerms(); renderNotificationSense(); renderRecovery(); renderResident() }
        }.start()
        ui.postDelayed({ refresh() }, 3000)
    }

    private fun startKernel(action: String) {
        if (KernelLauncher.installedVersion(this) == null) { Toast.makeText(this, "内核包未安装", Toast.LENGTH_SHORT).show(); return }
        if (!KernelLauncher.start(this, action)) Toast.makeText(this, "无法启动内核", Toast.LENGTH_SHORT).show()
    }

    private fun renderPerms() {
        perms.removeAllViews()
        for (item in Permissions.all) {
            val ok = item.granted(this)
            val extra = item.status(this)?.let { "\n$it" } ?: ""
            perms.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(TextView(context).apply { text = "${if (ok) "✅" else "⚪️"} ${item.title}\n${item.why}$extra"; textSize = 13f; layoutParams = LinearLayout.LayoutParams(0, -2, 1f) })
                if (!ok) addView(Button(context).apply { text = "去开启"; isAllCaps = false; setOnClickListener { item.open(this@ConsoleActivity) } })
                // A switch the phone keeps from Ash: try it, then say it is done.
                if (!ok && item.test != null && item.ready(this@ConsoleActivity))
                    addView(Button(context).apply { text = "测试"; isAllCaps = false; setOnClickListener { item.test.invoke(this@ConsoleActivity) } })
                if (item.awaitsWord(this@ConsoleActivity))
                    addView(Button(context).apply { text = "已设好"; isAllCaps = false; setOnClickListener { item.confirm(this@ConsoleActivity); renderPerms() } })
            })
        }
    }

    /** What recovery may do, whether it is on, and when it last acted. */
    private fun renderRecovery() {
        val r = ai.ash.caps.config.ScreenRecovery
        val times = r.history(this).takeLast(3).reversed().joinToString("、") { java.text.SimpleDateFormat("M月d日 HH:mm", java.util.Locale.CHINA).format(java.util.Date(it)) }
        recoveryState.text = buildString {
            append(if (!r.granted(this@ConsoleActivity)) "未授权（见上方「无障碍自动恢复」）。" else if (r.enabled(this@ConsoleActivity)) "已开启。" else "已关闭。")
            append("只做一件事：Ash 的无障碍开关开着、但它被系统停掉时，把它重新拉起来；你关掉的开关不会去开。")
            append(if (times.isEmpty()) "还没有恢复过。" else "最近恢复：$times。")
        }
        recoveryToggle.text = if (r.enabled(this)) "关闭自动恢复" else "开启自动恢复"
        recoveryToggle.visibility = if (r.granted(this)) View.VISIBLE else View.GONE
    }

    /** The island's resident entry: on or off. */
    private fun renderResident() {
        val kept = TaskCapsule.residentKept(this)
        residentState.text = when {
            !kept -> "已关闭：灵动岛只在任务进行中、或有你没看过的新东西时出现。"
            else -> "已开启：平时贴着摄像头显示 Ash 的头像。轻点直接跟 Ash 说，长按打开 Ash，上划收起到下次解锁。"
        }
        residentToggle.text = if (kept) "关闭常驻入口" else "开启常驻入口"
    }

    private fun renderNotificationSense() {
        val enabled = NotificationSenseSettings.enabled(this)
        val granted = NotificationSenseSettings.granted(this)
        notificationState.text = when {
            !enabled -> "本机开关：关闭。系统授权：${if (granted) "已授权，但不会读取" else "未授权"}。"
            !granted -> "本机开关：开启；等待系统读取权限，不会发送通知内容。"
            else -> "本机开关与系统权限均已开启：仅发送之后新到的通知。"
        }
        notificationToggle.text = if (enabled) "关闭通知读取" else "开启通知读取"
    }

    private fun openNotificationAccess() {
        try {
            startActivity(NotificationSenseSettings.accessIntent(this))
        } catch (_: Exception) {
            try { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
            catch (_: Exception) { Toast.makeText(this, "无法打开系统通知读取设置", Toast.LENGTH_SHORT).show() }
        }
    }

    private fun showPreview() {
        val msg = when (VScreenPreview.show(this)) {
            VScreenPreview.Shown.OK -> "已显示虚拟屏预览"
            VScreenPreview.Shown.NO_SCREEN -> "当前没有虚拟屏（Ash 用到虚拟屏时会自动显示预览）"
            VScreenPreview.Shown.NO_PERMISSION -> "需要先开启「悬浮窗」权限"
        }
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    @Suppress("unused")
    private fun hide(v: View) { v.visibility = View.GONE }
}
