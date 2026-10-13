package ai.ash.ui.design

import ai.ash.R
import ai.ash.screen.island.IslandTokens
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Outline
import android.graphics.drawable.Drawable
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.TouchDelegate
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.annotation.DrawableRes
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * 整页的骨架（顶栏、大标题、滚动页、空状态、抽屉、应用图标块），建在 [AshUi] 之上；尺寸颜色只来自 [AshTokens]，
 * 设计稿里不是令牌的几个数（应用图标块的大小和圆角）收在 [AppTile]。网页端对应 ash-ui.css 的 .navbar / .large-title / .page / .empty / .sheet。
 */
object AshPage {
    /** 设计稿 Apps 板里应用图标块的三种大小（dp）和圆角（dp）：网格 62/19、详情 84/26、横幅 40/12、应用外框 24/7。 */
    enum class AppTile(val sizeDp: Int, val radiusDp: Int, val glyphDp: Int) {
        GRID(62, 19, 26), DETAIL(84, 26, 38), BANNER(40, 12, 18), FRAME(24, 7, 16)
    }

    fun icon(ctx: Context, @DrawableRes id: Int): Drawable = ctx.getDrawable(id)!!.mutate()

    /** 一屏的底：页面底色，纵向排。 */
    fun screen(ctx: Context): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(AshUi.p(ctx).bg)
    }

    /**
     * 顶栏：左边 44dp 返回，中间标题（或自定义的 [center]），右边 [trailing]（没有就留 44dp 的空，让标题居中）。高 52，两侧 6。
     */
    fun navbar(ctx: Context, title: CharSequence?, backLabel: String, trailing: View? = null, center: View? = null, onBack: () -> Unit): LinearLayout =
        AshUi.hstack(ctx, 4).apply {
            minimumHeight = AshUi.dp(ctx, AshTokens.Size.navBar)
            setPadding(AshUi.dp(ctx, 6), 0, AshUi.dp(ctx, 6), 0)
            // A centred title sits where the island's pill may be: the bar moves down until the title is clear of it.
            if (title != null || center != null) clearOfIsland(this)
            addView(AshUi.iconButton(ctx, icon(ctx, R.drawable.ash_ic_back), backLabel, onClick = onBack))
            val mid = center ?: AshUi.text(ctx, title ?: "", AshTokens.Type.headline).apply {
                gravity = Gravity.CENTER; maxLines = 1; ellipsize = TextUtils.TruncateAt.END
            }
            addView(mid, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { gravity = Gravity.CENTER_VERTICAL })
            val size = AshUi.dp(ctx, AshTokens.Size.iconButton)
            addView(trailing ?: View(ctx), LinearLayout.LayoutParams(size, size))
        }

    /**
     * 灵动岛常驻（或有任务）时，药丸在屏幕顶部正中。居中的标题要让开它：这里只读岛的尺寸（[IslandTokens]，和引导页一样），
     * 岛本身一行不动。药丸下沿 = 状态栏下沿 + [IslandTokens.SIZE_TOP_BELOW_STATUS_BAR] + 药丸高；有摄像头孔的机器它贴着摄像头，下沿更靠上。
     * 页面已经给系统栏和摄像头孔让过位了（[ai.ash.apps.Ui.insets]），所以只补还差的那一截，让标题（一行 24dp）的上沿落在药丸下沿以下。
     */
    fun clearOfIsland(bar: View) {
        val ctx = bar.context
        val place = {
            val insets = ViewCompat.getRootWindowInsets(bar)
            val d = ctx.resources.displayMetrics.density
            val bars = (insets?.getInsets(WindowInsetsCompat.Type.systemBars())?.top ?: 0) / d
            val hole = (insets?.getInsets(WindowInsetsCompat.Type.displayCutout())?.top ?: 0) / d
            bar.setPadding(bar.paddingLeft, AshUi.dp(ctx, islandPaddingDp(bars, hole)), bar.paddingRight, bar.paddingBottom)
        }
        if (bar.isAttachedToWindow) place() else bar.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) { v.removeOnAttachStateChangeListener(this); place() }
            override fun onViewDetachedFromWindow(v: View) {}
        })
    }

    /**
     * How far down a bar with a centred title must start (dp) to be clear of the island: the pill's lower edge (below the status bar by
     * [IslandTokens.SIZE_TOP_BELOW_STATUS_BAR] and the pill's height; on a phone with a camera hole the pill hugs the camera, higher up) less
     * what the page already leaves free at the top ([bars], [hole]: the insets), so that the title line starts below it. Never negative.
     */
    internal fun islandPaddingDp(bars: Float, hole: Float): Float {
        val pillBottom = if (hole > 0f) IslandTokens.SIZE_TOP_HUG_CAMERA + IslandTokens.SIZE_COMPACT_HUG_CAMERA_H
            else bars + IslandTokens.SIZE_TOP_BELOW_STATUS_BAR + IslandTokens.SIZE_PILL_NO_CUTOUT_H
        val clear = pillBottom - maxOf(bars, hole)
        // The bar's controls are 44dp tall and the 24dp title line is centred in them: it starts (44 - 24) / 2 below the bar's own top padding.
        val titleTop = (AshTokens.Size.iconButton - 24) / 2f
        return (clear - titleTop).coerceAtLeast(0f)
    }

    /**
     * 可点的东西不小于 44dp：把 [parent] 里这些 [children]（可见尺寸不变）的点击区向上下扩到 [AshTokens.Size.touch]。
     * 点击区不能超出 [parent] 自己的范围：上面留得不够就多往下扩。
     */
    fun widenTouch(parent: ViewGroup, children: List<View>) {
        fun inside(c: View): Boolean { var v: View? = c; while (v != null && v !== parent) v = v.parent as? View; return v === parent }
        fun apply() {
            val group = TouchGroup(parent)
            val min = AshUi.dp(parent.context, AshTokens.Size.touch)
            for (c in children) {
                if (c.height <= 0 || !inside(c)) continue          // a child taken out since (the parent was filled again) has nothing to widen
                val r = Rect(0, 0, c.width, c.height)
                parent.offsetDescendantRectToMyCoords(c, r)
                val need = (min - c.height).coerceAtLeast(0)
                val up = minOf(need / 2, r.top)           // as far up as the parent lets it, the rest down
                r.top -= up
                r.bottom = minOf(r.bottom + (need - up), parent.height)
                group.add(TouchDelegate(r, c))
            }
            parent.touchDelegate = group
        }
        // One listener per parent: asking again for the same parent (its children changed) replaces the one before.
        widened.remove(parent)?.let { parent.removeOnLayoutChangeListener(it) }
        val listener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> apply() }
        widened[parent] = listener
        parent.addOnLayoutChangeListener(listener)
        parent.post { apply() }
    }

    private val widened = java.util.WeakHashMap<ViewGroup, View.OnLayoutChangeListener>()

    /** 一个 view 只能有一个 TouchDelegate；这个把几个合起来，谁认领这次触摸就给谁。 */
    private class TouchGroup(host: View) : TouchDelegate(Rect(), host) {
        private val parts = mutableListOf<TouchDelegate>()
        private var active: TouchDelegate? = null
        fun add(d: TouchDelegate) { parts += d }
        override fun onTouchEvent(event: MotionEvent): Boolean {
            if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                active = parts.firstOrNull { d -> MotionEvent.obtain(event).let { copy -> d.onTouchEvent(copy).also { copy.recycle() } } }
                return active != null
            }
            val a = active ?: return false
            val handled = a.onTouchEvent(event)
            if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) active = null
            return handled
        }
    }

    /** 大标题（30 号）：「应用」。 */
    fun largeTitle(ctx: Context, text: CharSequence): TextView = AshUi.text(ctx, text, AshTokens.Type.display).apply {
        setPadding(AshUi.dp(ctx, AshTokens.Space.lg), 0, AshUi.dp(ctx, AshTokens.Space.lg), AshUi.dp(ctx, 14))
    }

    /** 滚动页：左右 16，底 16，块与块之间隔 [gapDp]。 */
    fun scroll(ctx: Context, gapDp: Int, views: List<View>, topDp: Int = 0): ScrollView = ScrollView(ctx).apply {
        isVerticalScrollBarEnabled = false
        overScrollMode = View.OVER_SCROLL_NEVER
        addView(AshUi.vstack(ctx, gapDp).apply {
            val x = AshUi.dp(ctx, AshTokens.Space.pageX)
            setPadding(x, AshUi.dp(ctx, topDp), x, x)
            views.forEach { addView(it) }
        }, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    /** 组下面的小字（12 号、第三级文字）。 */
    fun foot(ctx: Context, text: CharSequence, center: Boolean = false): TextView =
        AshUi.text(ctx, text, AshType(12f, 18f, 400, Role.TEXT_3)).apply {
            setPadding(AshUi.dp(ctx, 6), 0, AshUi.dp(ctx, 6), 0)
            if (center) gravity = Gravity.CENTER_HORIZONTAL
        }

    /** 一块圆角 20 的白卡（体检卡、横幅）：卡面色、暖阴影，内边距自己定；[ring] 给它描一圈 1.5dp 的边（横幅用琥珀）。 */
    fun panel(ctx: Context, ring: Int? = null): LinearLayout = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        val c = AshUi.p(ctx)
        background = AshUi.rounded(c.surface, AshUi.dpF(ctx, AshTokens.Radius.lg.toFloat()), ring, if (ring != null) AshUi.dp(ctx, 1.5f) else 0)
        AshUi.cardShadow(this)
    }

    /** 空状态用的那块小插画：六格，一格珊瑚淡、一格薄荷淡，其余只描边。 */
    private fun emptyArt(ctx: Context): LinearLayout {
        val c = AshUi.p(ctx)
        val w = AshUi.dp(ctx, 44); val r = AshUi.dpF(ctx, AshTokens.Radius.sm.toFloat())
        fun cell(fill: Int?): View = View(ctx).apply {
            background = if (fill != null) AshUi.rounded(fill, r) else AshUi.rounded(Color.TRANSPARENT, r, c.line2, AshUi.dp(ctx, 1))
        }
        fun row(a: Int?, b: Int?, d: Int?) = AshUi.hstack(ctx, 10).apply {
            gravity = Gravity.CENTER
            for ((i, f) in listOf(a, b, d).withIndex()) addView(cell(f), LinearLayout.LayoutParams(w, AshUi.dp(ctx, if (f == null) 46 else 44)))
        }
        return AshUi.vstack(ctx, 10).apply {
            addView(row(null, c.youSoft, null)); addView(row(null, null, c.herSoft))
        }
    }

    /** 空状态：居中的小插画 + 一句标题 + 一段说明 + 可选的按钮。 */
    fun empty(ctx: Context, title: String, body: String, action: View? = null): LinearLayout = AshUi.vstack(ctx, 10).apply {
        gravity = Gravity.CENTER
        setPadding(AshUi.dp(ctx, 40), 0, AshUi.dp(ctx, 40), AshUi.dp(ctx, 80))
        addView(emptyArt(ctx), LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { bottomMargin = AshUi.dp(ctx, 8) })
        addView(AshUi.text(ctx, title, AshTokens.Type.headline).apply { gravity = Gravity.CENTER })
        addView(AshUi.text(ctx, body, AshTokens.Type.callout).apply { gravity = Gravity.CENTER })
        action?.let { addView(it, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, it.layoutParams?.height ?: ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = AshUi.dp(ctx, 10) }) }
    }

    /**
     * 应用图标块：应用自己给的位图裁成圆角方块（没有就用一个淡色底的盒子图标）。停用的整块 35%。
     * 亮色带暖阴影，暗色不带。
     */
    fun appIcon(ctx: Context, bitmap: Bitmap?, tile: AppTile, shadow: Boolean = true, dimmed: Boolean = false): FrameLayout = FrameLayout(ctx).apply {
        val c = AshUi.p(ctx)
        val size = AshUi.dp(ctx, tile.sizeDp); val radius = AshUi.dpF(ctx, tile.radiusDp.toFloat())
        layoutParams = ViewGroup.LayoutParams(size, size)
        outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) { outline.setRoundRect(0, 0, view.width, view.height, radius) }
        }
        clipToOutline = true
        if (bitmap != null) {
            addView(ImageView(ctx).apply { setImageBitmap(bitmap); scaleType = ImageView.ScaleType.CENTER_CROP }, FrameLayout.LayoutParams(-1, -1))
        } else {
            background = AshUi.rounded(c.surface2, radius)
            addView(View(ctx).apply { background = icon(ctx, R.drawable.ash_ic_box).apply { setTint(c.youText) } },
                FrameLayout.LayoutParams(AshUi.dp(ctx, tile.glyphDp), AshUi.dp(ctx, tile.glyphDp), Gravity.CENTER))
        }
        if (shadow) AshUi.cardShadow(this)
        if (dimmed) alpha = 0.35f
    }

    /**
     * 小号按钮（34dp 高）带上外面的点击区：外面包一层 44dp 高的框，点框里的任何地方都算按钮被点。
     * 设计里小号按钮只画 34dp，但可点的东西不能小于 44dp（HANDOFF §4）。
     */
    fun smallButton(ctx: Context, label: CharSequence, kind: AshUi.Kind, onClick: () -> Unit): FrameLayout = FrameLayout(ctx).apply {
        val button = AshUi.button(ctx, label, kind, AshUi.BtnSize.SM, onClick = onClick)
        isClickable = true; isFocusable = false
        setOnClickListener { button.performClick() }
        addView(button, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, AshUi.dp(ctx, AshTokens.Size.buttonSm), Gravity.CENTER_VERTICAL))
        minimumHeight = AshUi.dp(ctx, AshTokens.Size.touch)
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, AshUi.dp(ctx, AshTokens.Size.touch))
    }

    /**
     * 小号按钮占满所在格的宽（几个按钮并排各占一份时用）：画 34dp 高，外面同样套 44dp 的点击区。[onClick] 为空时不可点（按钮 40% 透明）。
     */
    fun smallButtonFill(ctx: Context, label: CharSequence, kind: AshUi.Kind, onClick: (() -> Unit)?): FrameLayout = FrameLayout(ctx).apply {
        val button = AshUi.button(ctx, label, kind, AshUi.BtnSize.SM, onClick = onClick)
        if (onClick == null) AshUi.disable(button) else { isClickable = true; isFocusable = false; setOnClickListener { button.performClick() } }
        addView(button, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, AshUi.dp(ctx, AshTokens.Size.buttonSm), Gravity.CENTER_VERTICAL))
        minimumHeight = AshUi.dp(ctx, AshTokens.Size.touch)
    }

    /** 状态小点：和红色角标一样大（24dp = 20 + 2 圈页面色的边），没有字；[fill] 是灯的颜色（留意 / 有问题 / 暂停）。 */
    fun statusDot(ctx: Context, fill: Int): View = View(ctx).apply {
        val c = AshUi.p(ctx)
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(fill); setStroke(AshUi.dp(ctx, 2), c.bg) }
        elevation = AshUi.dpF(ctx, 4f); outlineProvider = null
        layoutParams = FrameLayout.LayoutParams(AshUi.dp(ctx, 24), AshUi.dp(ctx, 24))
    }

    /** 红色角标：「!」，24dp（20 + 2 圈页面色的边）。 */
    fun errorBadge(ctx: Context): TextView = AshUi.text(ctx, "!", AshType(12f, 16f, 700, null), Color.WHITE).apply {
        val c = AshUi.p(ctx)
        gravity = Gravity.CENTER
        background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(c.errFill); setStroke(AshUi.dp(ctx, 2), c.bg) }
        elevation = AshUi.dpF(ctx, 4f); outlineProvider = null // above the icon tile, whose shadow raises it; no shadow of its own
        layoutParams = FrameLayout.LayoutParams(AshUi.dp(ctx, 24), AshUi.dp(ctx, 24))
    }

    /**
     * 底部抽屉：盖在 [host] 上的一层幕布 + 从底部升起的抽屉（圆角 28、握把、360ms 缓动）。点幕布收起。
     * 同一时间只有一个。[host] 要是没有给系统栏让位的那一层（比如窗口的 `decorView`），抽屉才会铺到屏幕底；抽屉自己给导航栏留出底部。
     */
    class Sheet(private val host: FrameLayout) {
        private var layer: FrameLayout? = null
        val showing get() = layer != null

        fun show(fill: (LinearLayout) -> Unit) {
            dismiss(animate = false)
            val ctx = host.context
            val c = AshUi.p(ctx)
            val sheet = AshUi.vstack(ctx, 12).apply {
                background = AshUi.sheetBackground(ctx)
                elevation = AshUi.dpF(ctx, 12f)
                isClickable = true
                setPadding(AshUi.dp(ctx, AshTokens.Space.md), AshUi.dp(ctx, 14), AshUi.dp(ctx, AshTokens.Space.md), AshUi.dp(ctx, 28))
                addView(View(ctx).apply { background = AshUi.rounded(c.line2, AshUi.dpF(ctx, 3f)) },
                    LinearLayout.LayoutParams(AshUi.dp(ctx, 36), AshUi.dp(ctx, 5)).apply { gravity = Gravity.CENTER_HORIZONTAL })
                fill(this)
            }
            val scrim = View(ctx).apply { setBackgroundColor(c.scrim); isClickable = true; setOnClickListener { dismiss() } }
            val l = FrameLayout(ctx).apply {
                addView(scrim, FrameLayout.LayoutParams(-1, -1))
                addView(sheet, FrameLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
            }
            val base = AshUi.dp(ctx, 28)
            ViewCompat.setOnApplyWindowInsetsListener(l) { _, insets ->
                val bottom = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime()).bottom
                sheet.setPadding(sheet.paddingLeft, sheet.paddingTop, sheet.paddingRight, base + bottom)
                insets
            }
            layer = l
            host.addView(l, FrameLayout.LayoutParams(-1, -1))
            ViewCompat.requestApplyInsets(l)
            if (AshUi.motionOn(ctx)) {
                scrim.alpha = 0f
                sheet.visibility = View.INVISIBLE
                sheet.post {
                    sheet.translationY = sheet.height.toFloat(); sheet.visibility = View.VISIBLE
                    ValueAnimator.ofFloat(0f, 1f).apply {
                        duration = AshTokens.Motion.sheet; interpolator = AshTokens.Motion.easing()
                        addUpdateListener { sheet.translationY = sheet.height * (1f - it.animatedValue as Float); scrim.alpha = it.animatedValue as Float }
                        start()
                    }
                }
            }
        }

        fun dismiss(animate: Boolean = true) {
            val l = layer ?: return
            layer = null
            val sheet = l.getChildAt(1)
            if (animate && AshUi.motionOn(host.context) && sheet != null) {
                ValueAnimator.ofFloat(0f, 1f).apply {
                    duration = AshTokens.Motion.sheet; interpolator = AshTokens.Motion.easing()
                    addUpdateListener { sheet.translationY = sheet.height * it.animatedValue as Float; l.getChildAt(0).alpha = 1f - it.animatedValue as Float }
                    addListener(object : android.animation.AnimatorListenerAdapter() { override fun onAnimationEnd(a: android.animation.Animator) { host.removeView(l) } })
                    start()
                }
            } else host.removeView(l)
        }
    }
}
