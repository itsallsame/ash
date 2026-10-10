package ai.ash.ui

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import ai.ash.R
import ai.ash.apps.Ui
import ai.ash.caps.Capabilities
import ai.ash.caps.config.ConfigStatus
import ai.ash.caps.config.KeepAliveStatus
import ai.ash.caps.config.Permission
import ai.ash.caps.config.Permissions
import ai.ash.caps.config.ScreenRecovery
import ai.ash.host.KernelGate
import ai.ash.host.KernelInstaller
import ai.ash.host.KernelLauncher
import ai.ash.host.KernelState
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The first-launch guide (SPEC-05 §9): the kernel package, then the permissions and switches, the system's special
 * accesses, the senses, and done. [OnboardingPlan] decides which step is shown from the state of the kernel package and
 * of `config.status`; this class reads that state (off the main thread, once a second and whenever the owner comes
 * back from a settings page), starts the kernel when it does not run, and shows the step. Every button asks for
 * what the capability of the same name would. Each step can be skipped; nothing here is required.
 */
class OnboardingActivity : Activity() {
    private class Loaded(val kernel: KernelState, val items: List<ConfigStatus.Item>)

    private val ui = Handler(Looper.getMainLooper())
    private val reader = Executors.newSingleThreadExecutor { Thread(it, "ash-onboarding-read").apply { isDaemon = true } }
    private val skipped = mutableSetOf<OnboardingStep>()
    private var loaded: Loaded? = null
    private var loading = false
    private var startsTried = 0
    private var lastStart = 0L
    /** While the kernel package downloads or waits for the owner's confirmation: what to say. */
    @Volatile private var installing: String? = null
    @Volatile private var installError: String? = null

    private lateinit var count: TextView
    private lateinit var title: TextView
    private lateinit var body: TextView
    private lateinit var list: LinearLayout
    private lateinit var primary: Button
    private lateinit var secondary: Button
    private lateinit var dots: LinearLayout

    private val night get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    private val fg get() = if (night) Color.rgb(236, 236, 238) else Color.rgb(28, 28, 30)
    private val muted get() = if (night) Color.rgb(150, 150, 156) else Color.rgb(110, 110, 116)
    private val accent get() = getColor(R.color.accent)

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(if (night) R.style.Ash_Dark else R.style.Ash_Light)
        super.onCreate(savedInstanceState)
        savedInstanceState?.getIntArray(KEY_SKIPPED)?.forEach { skipped += OnboardingStep.entries[it] }

        count = TextView(this).apply { textSize = 13f; setTextColor(muted); gravity = Gravity.CENTER }
        title = TextView(this).apply { textSize = 24f; setTypeface(typeface, Typeface.BOLD); setTextColor(fg); gravity = Gravity.CENTER; setPadding(0, dp(8), 0, dp(12)) }
        body = TextView(this).apply { textSize = 15f; setTextColor(fg); gravity = Gravity.CENTER; setLineSpacing(0f, 1.3f) }
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(12), 0, 0) }
        primary = Button(this).apply {
            isAllCaps = false; textSize = 16f; setTextColor(Color.WHITE)
            background = GradientDrawable().apply { cornerRadius = dp(24).toFloat(); setColor(accent) }
            stateListAnimator = null
        }
        secondary = Button(this, null, android.R.attr.borderlessButtonStyle).apply { isAllCaps = false; textSize = 15f; setTextColor(muted) }
        dots = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER; setPadding(0, dp(12), 0, dp(12)) }

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(24), dp(24), dp(16))
            addView(count); addView(title); addView(body); addView(list)
        }
        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(32), 0, dp(32), dp(16))
            addView(dots)
            addView(primary, LinearLayout.LayoutParams(-1, dp(48)))
            addView(secondary, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) })
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(ScrollView(this@OnboardingActivity).apply { isFillViewport = true; addView(content) }, LinearLayout.LayoutParams(-1, 0, 1f))
            addView(bottom, LinearLayout.LayoutParams(-1, -2))
        }
        setContentView(root)
        Ui.insets(root)
    }

    override fun onResume() {
        super.onResume()
        reload()
    }

    override fun onPause() {
        ui.removeCallbacksAndMessages(null)
        super.onPause()
    }

    override fun onDestroy() {
        reader.shutdown()
        super.onDestroy()
    }

    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        out.putIntArray(KEY_SKIPPED, skipped.map { it.ordinal }.toIntArray())
    }

    /** Reads the kernel package and `config.status` (which may wait on Health Connect, so not on the main thread). */
    private fun reload() {
        ui.removeCallbacksAndMessages(null)
        if (!loading) {
            loading = true
            reader.execute {
                val read = runCatching { Loaded(KernelLauncher.state(this), items()) }.getOrNull()
                ui.post { loading = false; if (read != null && !isDestroyed) { loaded = read; keepKernelUp(read.kernel); render() } }
            }
        }
        ui.postDelayed(::reload, 1000)
    }

    /** `config.status`, the keep-alive switches the phone keeps, and whether Ash may bring its accessibility back by itself. */
    private fun items(): List<ConfigStatus.Item> {
        val keepAlive = if (KeepAliveStatus.supported()) KeepAliveStatus.items(this).filter { it.item !in ConfigStatus.NAMES } else emptyList()
        val recovery = ConfigStatus.Item("screen_recovery", if (ScreenRecovery.granted(this)) ConfigStatus.GRANTED else ConfigStatus.MISSING)
        return ConfigStatus.all(this) + keepAlive + recovery
    }

    private fun plan(l: Loaded) = OnboardingPlan.current(l.kernel, l.items.map { OnboardingPlan.Row(it.item, it.state) }, skipped)

    /** On the kernel step, an installed kernel that does not run is started, a few times, a while apart. */
    private fun keepKernelUp(kernel: KernelState) {
        if (kernel != KernelState.NOT_RUNNING) { startsTried = 0; return }
        val l = loaded ?: return
        if (plan(Loaded(kernel, l.items)) != OnboardingStep.KERNEL) return
        val now = SystemClock.elapsedRealtime()
        if (KernelGate.action(kernel, startsTried) == KernelGate.Action.START && now - lastStart > START_GAP_MS) {
            KernelLauncher.start(this)
            startsTried++; lastStart = now
        }
    }

    private fun render() {
        val l = loaded ?: return
        val step = plan(l)
        if (KernelInstaller.failure != null) installing = null
        dots.removeAllViews()
        for (s in OnboardingStep.entries) dots.addView(View(this).apply {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(if (s == step) accent else (muted and 0x00FFFFFF) or 0x66000000) }
        }, LinearLayout.LayoutParams(dp(if (s == step) 8 else 6), dp(if (s == step) 8 else 6)).apply { setMargins(dp(4), 0, dp(4), 0); gravity = Gravity.CENTER_VERTICAL })
        count.text = "第 ${step.ordinal + 1} / ${OnboardingStep.entries.size} 步"
        list.removeAllViews()
        primary.visibility = View.VISIBLE
        secondary.text = "跳过这一步"
        secondary.setOnClickListener { skipped += step; render() }
        secondary.visibility = if (step == OnboardingStep.DONE) View.GONE else View.VISIBLE

        when (step) {
            OnboardingStep.KERNEL -> kernelStep(l.kernel)
            OnboardingStep.PERMISSIONS -> rowsStep(l, step, "权限和开关", "这些让提醒准时、让 Ash 在后台一直活着。每一项都可以先不开。")
            OnboardingStep.SCREEN_ACCESS -> rowsStep(l, step, "无障碍和通知读取", "Ash 看懂屏幕、替你操作手机，靠无障碍；这两项要在系统设置里亲自打开。")
            OnboardingStep.SENSES -> rowsStep(l, step, "位置和健康", "可以不开。开了，Ash 才知道你在哪、走了多少步；数据只存在手机上。")
            OnboardingStep.DONE -> {
                title.text = "准备好了"
                val on = l.items.count { it.state == ConfigStatus.GRANTED }
                body.text = "已开启 $on / ${l.items.size} 项。以后可以在「诊断」页随时开启，或再次打开这个引导。"
                primary.text = "完成"
                primary.setOnClickListener { done() }
            }
        }
    }

    private fun kernelStep(state: KernelState) {
        title.text = "Ash 内核"
        when (state) {
            KernelState.NOT_INSTALLED -> {
                val say = installError ?: KernelInstaller.failure ?: installing
                body.text = say ?: ("Ash 的大脑在单独的「内核包」里，还没有安装。" +
                    if (KernelInstaller.configured) "\n\n点下面的按钮下载并安装。" else "\n\n这个版本没有带下载地址，请先自己安装内核包。")
                primary.visibility = if (KernelInstaller.configured && installing == null) View.VISIBLE else View.GONE
                primary.text = if (KernelInstaller.mayInstall(this)) "下载并安装" else "先允许 Ash 安装应用"
                primary.setOnClickListener { installKernel() }
            }
            else -> {
                val gave = KernelGate.action(state, startsTried) == KernelGate.Action.WAIT
                body.text = if (gave) "内核未运行。已经试着启动 $startsTried 次，还是没有起来。" else "内核未运行，正在启动…"
                primary.visibility = if (gave) View.VISIBLE else View.GONE
                primary.text = "再试一次"
                primary.setOnClickListener { startsTried = 0; lastStart = 0; keepKernelUp(KernelState.NOT_RUNNING); render() }
            }
        }
    }

    private fun rowsStep(l: Loaded, step: OnboardingStep, heading: String, intro: String) {
        title.text = heading
        body.text = intro
        primary.visibility = View.GONE
        val rows = OnboardingPlan.rows(step, l.kernel, l.items.map { OnboardingPlan.Row(it.item, it.state) }).map { r -> l.items.first { it.item == r.item } }
        for (item in rows) list.addView(rowView(item))
    }

    private fun rowView(item: ConfigStatus.Item): View {
        val permission = permissionOf(item.item)
        val (name, why) = OWN[item.item] ?: ((permission?.title ?: item.item) to (permission?.why ?: ""))
        val ok = item.state == ConfigStatus.GRANTED || item.state == ConfigStatus.UNSUPPORTED
        val mark = when (item.state) { ConfigStatus.GRANTED -> "✅"; ConfigStatus.UNSUPPORTED -> "➖"; else -> "⚪️" }
        val detail = item.detail?.takeIf { !ok }?.let { "\n$it" }.orEmpty()
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(10), 0, dp(10))
            addView(TextView(context).apply {
                text = "$mark $name\n$why$detail"; textSize = 14f; setTextColor(fg); setLineSpacing(0f, 1.2f)
            }, LinearLayout.LayoutParams(0, -2, 1f))
            if (!ok) addView(Button(context).apply { text = "去开启"; isAllCaps = false; setOnClickListener { act(item.item) } })
            if (permission?.awaitsWord(this@OnboardingActivity) == true)
                addView(Button(context, null, android.R.attr.borderlessButtonStyle).apply {
                    text = "已设好"; isAllCaps = false; setTextColor(accent); setOnClickListener { permission.confirm(this@OnboardingActivity); reload() }
                })
        }
    }

    /** The button of a row does what the capability of the same name does; the keep-alive switches are the owner's tap on their entry. */
    private fun act(item: String) {
        if (item !in ConfigStatus.NAMES) return run { permissionOf(item)?.open(this) }
        Thread({
            // With the grant for secure settings Ash switches the accessibility service on itself; without it, or if that fails, the owner is taken to its page.
            val enabled = item == "accessibility" && ScreenRecovery.granted(this) &&
                Capabilities.call(this, "config.accessibility.enable", JSONObject()).toJson().optBoolean("ok")
            if (!enabled) Capabilities.call(this, "config.permission.request", JSONObject().put("name", item))
        }, "ash-onboarding-act").start()
    }

    private fun installKernel() {
        if (!KernelInstaller.mayInstall(this)) { startActivity(KernelInstaller.allowIntent(this)); return }
        installError = null; installing = "正在下载…"; render()
        Thread({
            try {
                val apk = KernelInstaller.download(this) { done, total ->
                    installing = if (total > 0) "正在下载 ${done * 100 / total}%" else "正在下载 ${done / 1_000_000} MB"
                }
                val bad = KernelInstaller.problem(this, apk)
                if (bad != null) { installError = bad; installing = null; apk.delete() }
                else { installing = "下载好了，等你在系统的安装页上确认"; KernelInstaller.install(this, apk) }
            } catch (e: Exception) {
                installError = "下载或安装没成功：${e.message ?: e.javaClass.simpleName}"; installing = null
            }
        }, "ash-kernel-install").start()
    }

    private fun done() {
        startActivity(Intent(this, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() = done()

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val KEY_SKIPPED = "skipped"
        private const val PREFS = "ash.ui"
        private const val SEEN = "onboarding_seen"
        private const val START_GAP_MS = 20_000L

        /** The entries of [Permissions] that stand for items outside `config.status` (the keep-alive switches, the recovery grant). */
        private val EXTRA_KEYS = mapOf("autostart" to "autostart", "recents_lock" to "lock", "screen_recovery" to "screen_recovery")

        /** Items without an entry in [Permissions]: their name and what they give. */
        private val OWN = mapOf(
            "exact_alarm" to ("精确闹钟" to "让日历提醒准时响起；不开的话，提醒可能晚几分钟"),
            "kernel_battery_optimization" to ("内核不受电池优化限制" to "内核是 Ash 的大脑，系统在后台停掉它，Ash 就失联了"),
            "location" to ("位置" to "取当前位置、记录轨迹"),
            "location_background" to ("后台位置（始终允许）" to "锁屏或不在前台时也能取到位置"),
            "activity_recognition" to ("运动与健身" to "计步、区分静止、步行和跑步"),
            "health" to ("健康数据（Health Connect）" to "只读：步数、心率、睡眠、体重等"),
        )

        private fun permissionOf(item: String): Permission? {
            val key = ConfigStatus.PERMISSION_KEY[item] ?: EXTRA_KEYS[item] ?: return null
            return Permissions.all.firstOrNull { it.key == key }
        }

        @Volatile private var offered = false

        /** Shows the guide once, on the first launch; marks it seen right away so a crash or kill never loops it. */
        fun showOnce(from: Activity): Boolean {
            val prefs = from.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (prefs.getBoolean(SEEN, false)) return false
            prefs.edit().putBoolean(SEEN, true).apply()
            offered = true
            from.startActivity(Intent(from, OnboardingActivity::class.java))
            return true
        }

        /** The kernel package is gone after the first launch: the guide (which starts with installing it) comes up once per run of the app. */
        fun offerKernel(from: Activity) {
            if (offered) return
            offered = true
            from.startActivity(Intent(from, OnboardingActivity::class.java))
        }
    }
}
