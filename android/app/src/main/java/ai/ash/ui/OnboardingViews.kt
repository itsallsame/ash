package ai.ash.ui

import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.Role
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The pieces the guide draws that the component library has no name for yet: the ring of light around her (download
 * progress, how many things are on), the dots, a button with an icon, and the glow behind the first screen.
 * Sizes are the ones of design/app/redlines/Setup--* (dp); colours and type come from the tokens.
 */
internal object OnboardingViews {
    /** Measures from the Setup redlines that are layout, not tokens. */
    object Layout {
        const val dotsTop = 16
        const val dot = 6
        const val dotActive = 18
        const val dotGap = 6
        const val dotsRow = 22

        const val welcomeAvatar = 136
        const val welcomeTitleTop = 16
        const val glow = 460

        const val brainRing = 176
        const val brainRingRadius = 82
        const val doneRing = 168
        const val doneRingRadius = 78
        const val ringStroke = 5
        const val ringAvatar = 120
        const val doneTop = 72

        const val bubbleAvatar = 40
        const val avatarPad = 3
        const val tilt = -1.5f
        /** The example card sits higher than the page's cards (the design's larger shadow). */
        const val liftedShadow = 8f
        const val previewTop = 18
        const val previewSide = 6
        const val pageGapAsk = 22
        const val pageGapHand = 18
        const val handHeader = 38
        const val handRow = 52
        const val handIcon = 28
        const val handIconRadius = 8
        const val handBar = 3
        const val handFaded = 0.45f
        const val stepsGap = 8
        const val stepsPadX = 4
        const val tagH = 30
        const val tagPadX = 12
        const val tagRadius = 11
        const val barAsk = 34
        const val barSimple = 40
        const val barGap = 4
        const val sideX = 24
        const val sideWide = 32
    }

    val bubbleType = AshType(17f, 27f, 400, Role.TEXT)
    val previewName = AshType(13f, 18f, 600, Role.INK)
    val previewBody = AshType(14f, 20f, 400, Role.TEXT)
    val handName = AshType(14.5f, 20f, 400, Role.TEXT)
    val handNameOn = AshType(14.5f, 20f, 600, Role.INK)
    val handPath = AshType(12f, 16f, 400, Role.TEXT_3)
    val handStep = AshType(14f, 21f, 400, Role.TEXT_2)
    val welcomeTitle = AshType(32f, 40f, 700, Role.INK)
    val welcomeBody = AshType(16f, 26f, 400, Role.TEXT_2)
    val brainLabel = AshType(15f, 20f, 600, null)
    val brainTitle = AshType(20f, 30f, 600, Role.INK)
    val brainBody = AshType(15f, 24f, 400, Role.TEXT_2)
    val doneBody = AshType(15.5f, 25f, 400, Role.TEXT_2)
    val tagType = AshType(13f, 18f, 600, null)

    private val faces = HashMap<String, Bitmap?>()

    /** One of her faces (the same set the island uses); null when the asset is missing. */
    fun face(ctx: Context, name: String): Bitmap? = synchronized(faces) {
        faces.getOrPut(name) { runCatching { ctx.assets.open("ash-ui/avatars/$name.webp").use { BitmapFactory.decodeStream(it) } }.getOrNull() }
    }

    /** A square avatar [sizeDp] wide: the view is [Layout.avatarPad] larger on every side (room for its ring), and the margins take that back. */
    fun avatar(ctx: Context, expression: String, sizeDp: Int, state: AshUi.AvatarView.State = AshUi.AvatarView.State.PLAIN): AshUi.AvatarView =
        AshUi.AvatarView(ctx).apply {
            image = face(ctx, expression); this.state = state
            // her face is a cut-out: the page's warm tile shows behind it, as in the design (the library's avatar draws the picture only)
            val pad = AshUi.dp(ctx, Layout.avatarPad)
            background = android.graphics.drawable.InsetDrawable(
                AshUi.rounded(AshUi.p(ctx).surface2, AshUi.dpF(ctx, sizeDp * AshTokens.Radius.avatarFraction)), pad)
        }.also {
            it.layoutParams = LinearLayout.LayoutParams(AshUi.dp(ctx, sizeDp + 2 * Layout.avatarPad), AshUi.dp(ctx, sizeDp + 2 * Layout.avatarPad)).apply {
                val m = -AshUi.dp(ctx, Layout.avatarPad)
                setMargins(m, m, m, m)
            }
        }

    /** `**word**` marks the word that carries the sentence. */
    fun rich(ctx: Context, s: String): CharSequence {
        val out = SpannableStringBuilder()
        s.split("**").forEachIndexed { i, part ->
            val start = out.length
            out.append(part)
            if (i % 2 == 1) {
                val span: Any = if (Build.VERSION.SDK_INT >= 28) TypefaceSpan(Typeface.create(Typeface.DEFAULT, 600, false)) else StyleSpan(Typeface.BOLD)
                out.setSpan(span, start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        return out
    }

    /** The dots at the top: [done] and the active one are ink, the active one is wider, the rest wait. */
    fun dots(ctx: Context, states: List<DotState>): LinearLayout {
        val c = AshUi.p(ctx)
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER
            setPadding(0, AshUi.dp(ctx, Layout.dotsTop), 0, 0)
            states.forEachIndexed { i, s ->
                addView(View(ctx).apply {
                    background = AshUi.rounded(if (s == DotState.UPCOMING) c.surface3 else c.ink, AshUi.dpF(ctx, Layout.dot / 2f))
                }, LinearLayout.LayoutParams(AshUi.dp(ctx, if (s == DotState.ACTIVE) Layout.dotActive else Layout.dot), AshUi.dp(ctx, Layout.dot)).apply {
                    if (i > 0) marginStart = AshUi.dp(ctx, Layout.dotGap)
                })
            }
        }
    }

    enum class DotState { DONE, ACTIVE, UPCOMING }

    /** A full-width pill with an icon before the label (the icon sits with the text, not at the edge). */
    fun iconButton(ctx: Context, label: String, icon: Int, onClick: () -> Unit): View {
        val c = AshUi.p(ctx)
        val shell = AshUi.button(ctx, "", AshUi.Kind.PRIMARY, AshUi.BtnSize.LG, block = true)
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER
            background = shell.background; isClickable = true; isFocusable = true
            layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, AshUi.dp(ctx, AshTokens.Size.buttonLg))
            addView(ImageView(ctx).apply { setImageDrawable(ctx.getDrawable(icon)?.mutate()?.apply { setTint(c.onYou) }) },
                LinearLayout.LayoutParams(AshUi.dp(ctx, AshTokens.Size.iconSm), AshUi.dp(ctx, AshTokens.Size.iconSm)).apply { marginEnd = AshUi.dp(ctx, 6) })
            addView(AshUi.text(ctx, label, AshTokens.Type.button, c.onYou))
            setOnClickListener { onClick() }
        }
    }

    /** The quiet second button: 「先不用」 in the second text colour. */
    fun ghost(ctx: Context, label: String, onClick: () -> Unit): TextView =
        AshUi.button(ctx, label, AshUi.Kind.GHOST, AshUi.BtnSize.MD, block = true, onClick = onClick).also { it.setTextColor(AshUi.p(ctx).text2) }

    /** The glow behind her on the first screen: her soft colour fading to nothing. */
    fun glow(ctx: Context): View = View(ctx).apply {
        val r = AshUi.dpF(ctx, Layout.glow / 2f)
        background = GradientDrawable().apply {
            gradientType = GradientDrawable.RADIAL_GRADIENT; gradientRadius = r
            colors = intArrayOf(AshUi.p(ctx).herSoft, Color.TRANSPARENT)
        }
    }

    /** A small label on the closing screen for something that stayed off. */
    fun offTag(ctx: Context, label: String): TextView {
        val c = AshUi.p(ctx)
        return AshUi.text(ctx, label, tagType, c.text2).apply {
            gravity = Gravity.CENTER; height = AshUi.dp(ctx, Layout.tagH)
            setPadding(AshUi.dp(ctx, Layout.tagPadX), 0, AshUi.dp(ctx, Layout.tagPadX), 0)
            background = AshUi.rounded(c.surface2, AshUi.dpF(ctx, Layout.tagRadius.toFloat()))
        }
    }

    /**
     * Her face in a round frame with a ring of light around it: [progress] of the ring is lit (from the top, clockwise);
     * [spinning] lights a short arc that goes round instead (no animation when the system's animations are off).
     */
    class RingAvatar(ctx: Context, private val boxDp: Int, private val radiusDp: Int) : View(ctx) {
        var image: Bitmap? = null; set(v) { field = v; invalidate() }
        var progress = 0f; private set
        var spinning = false; set(v) { field = v; restart(); invalidate() }
        private val c = AshUi.p(ctx)
        private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = c.surface3 }
        private val arc = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = c.herFill; strokeCap = Paint.Cap.ROUND }
        private val img = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        private var turn = 0f
        private var spin: ValueAnimator? = null
        private var grow: ValueAnimator? = null

        /** Moves the lit part of the ring to [to] (0..1), smoothly when animations are on. */
        fun setProgress(to: Float, animate: Boolean = true) {
            val target = to.coerceIn(0f, 1f)
            grow?.cancel()
            if (!animate || !AshUi.motionOn(context) || !isAttachedToWindow) { progress = target; invalidate(); return }
            grow = ValueAnimator.ofFloat(progress, target).apply {
                duration = AshTokens.Motion.cardResolve; interpolator = AshTokens.Motion.easing()
                addUpdateListener { progress = it.animatedValue as Float; invalidate() }; start()
            }
        }

        private fun restart() {
            spin?.cancel(); spin = null
            if (!spinning || !isAttachedToWindow || !AshUi.motionOn(context)) return
            spin = ValueAnimator.ofFloat(0f, 360f).apply {
                duration = AshTokens.Motion.ring; repeatCount = ValueAnimator.INFINITE; interpolator = android.view.animation.LinearInterpolator()
                addUpdateListener { turn = it.animatedValue as Float; invalidate() }; start()
            }
        }

        override fun onAttachedToWindow() { super.onAttachedToWindow(); restart() }
        override fun onDetachedFromWindow() { spin?.cancel(); grow?.cancel(); super.onDetachedFromWindow() }
        override fun onMeasure(w: Int, h: Int) = setMeasuredDimension(AshUi.dp(context, boxDp), AshUi.dp(context, boxDp))

        override fun onDraw(canvas: Canvas) {
            val cx = width / 2f; val cy = height / 2f
            val stroke = AshUi.dpF(context, Layout.ringStroke.toFloat())
            track.strokeWidth = stroke; arc.strokeWidth = stroke
            val r = AshUi.dpF(context, radiusDp.toFloat())
            val oval = RectF(cx - r, cy - r, cx + r, cy + r)
            canvas.drawOval(oval, track)
            when {
                spinning -> canvas.drawArc(oval, turn - 90f, 100f, false, arc)
                progress > 0f -> canvas.drawArc(oval, -90f, 360f * progress, false, arc)
            }
            val a = AshUi.dpF(context, Layout.ringAvatar / 2f)
            val box = RectF(cx - a, cy - a, cx + a, cy + a)
            val bmp = image
            img.shader = null; img.color = c.surface2; canvas.drawCircle(cx, cy, a, img)
            if (bmp == null) return
            val shader = BitmapShader(bmp, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
            val scale = maxOf(box.width() / bmp.width, box.height() / bmp.height)
            // object-position 50% 18%, as everywhere she is drawn: keep the face, crop from the top
            val dy = (box.height() - bmp.height * scale) * 0.18f
            shader.setLocalMatrix(Matrix().apply { setScale(scale, scale); postTranslate(box.left + (box.width() - bmp.width * scale) / 2, box.top + dy) })
            img.shader = shader
            canvas.drawCircle(cx, cy, a, img)
        }
    }

    /** Her words in a bubble, her face beside it (their bottoms level). */
    fun sayRow(ctx: Context, expression: String, say: String): LinearLayout = AshUi.hstack(ctx, 12).apply {
        gravity = Gravity.BOTTOM
        addView(avatar(ctx, expression, Layout.bubbleAvatar))
        addView(AshUi.text(ctx, rich(ctx, say), bubbleType).apply {
            background = AshUi.bubble(ctx, false)
            setPadding(AshUi.dp(ctx, 14), AshUi.dp(ctx, 10), AshUi.dp(ctx, 14), AshUi.dp(ctx, 10))
            AshUi.cardShadow(this)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    /** A small example of what she would send, tilted a little like something put down on the page. */
    fun previewCard(ctx: Context, p: OnboardingContent.Preview): LinearLayout = AshUi.hstack(ctx, 12).apply {
        val c = AshUi.p(ctx)
        background = AshUi.rounded(c.surface, AshUi.dpF(ctx, AshTokens.Radius.card.toFloat()))
        setPadding(AshUi.dp(ctx, AshTokens.Space.rowX), AshUi.dp(ctx, AshTokens.Space.rowX), AshUi.dp(ctx, AshTokens.Space.rowX), AshUi.dp(ctx, AshTokens.Space.rowX))
        AshUi.cardShadow(this, Layout.liftedShadow)
        rotation = Layout.tilt
        addView(avatar(ctx, "success", Layout.bubbleAvatar))
        addView(AshUi.vstack(ctx, 2).apply {
            addView(AshUi.hstack(ctx).apply {
                addView(AshUi.text(ctx, p.title, previewName), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(AshUi.text(ctx, p.whenText, AshTokens.Type.caption))
            })
            addView(AshUi.text(ctx, p.body, previewBody))
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    }

    /** The settings page the owner will land on, with the one row to switch lit and the neighbour faded. */
    fun handCard(ctx: Context, hand: OnboardingContent.Hand): LinearLayout = AshUi.vstack(ctx).apply {
        val c = AshUi.p(ctx)
        background = AshUi.rounded(c.surface, AshUi.dpF(ctx, AshTokens.Radius.card.toFloat())); clipToOutline = true
        AshUi.cardShadow(this)
        addView(AshUi.text(ctx, hand.path, handPath).apply {
            gravity = Gravity.CENTER_VERTICAL; minHeight = AshUi.dp(ctx, Layout.handHeader)
            setPadding(AshUi.dp(ctx, AshTokens.Space.rowX), 0, AshUi.dp(ctx, AshTokens.Space.rowX), 0)
        })
        addView(View(ctx).apply { setBackgroundColor(c.line) }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, maxOf(1, AshUi.dp(ctx, 0.5f))))
        addView(handRow(ctx, "其他应用", on = false))
        addView(handRow(ctx, "Ash", on = true))
    }

    private fun handRow(ctx: Context, name: String, on: Boolean): View {
        val c = AshUi.p(ctx)
        return AshUi.hstack(ctx, 12).apply {
            minimumHeight = AshUi.dp(ctx, Layout.handRow)
            setPadding(AshUi.dp(ctx, AshTokens.Space.rowX), 0, AshUi.dp(ctx, AshTokens.Space.rowX), 0)
            if (on) {
                // the lit row carries a bar of her colour on its left edge
                background = android.graphics.drawable.LayerDrawable(arrayOf(AshUi.rounded(c.youSoft, 0f), android.graphics.drawable.ColorDrawable(c.you))).apply {
                    setLayerSize(1, AshUi.dp(ctx, Layout.handBar), -1)
                    setLayerGravity(1, Gravity.START or Gravity.FILL_VERTICAL)
                }
            } else alpha = Layout.handFaded
            val icon = AshUi.dp(ctx, Layout.handIcon)
            if (on) addView(ImageView(ctx).apply { setImageDrawable(ctx.getDrawable(ai.ash.R.mipmap.ic_launcher)) }, LinearLayout.LayoutParams(icon, icon))
            else addView(View(ctx).apply { background = AshUi.rounded(c.surface3, AshUi.dpF(ctx, Layout.handIconRadius.toFloat())) }, LinearLayout.LayoutParams(icon, icon))
            addView(AshUi.text(ctx, name, if (on) handNameOn else handName), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(AshUi.AshSwitch(ctx).apply { set(on); isClickable = false; isFocusable = false })
        }
    }

    /** The three things to do, numbered. */
    fun steps(ctx: Context, hand: OnboardingContent.Hand): LinearLayout = AshUi.vstack(ctx, Layout.stepsGap).apply {
        setPadding(AshUi.dp(ctx, Layout.stepsPadX), 0, AshUi.dp(ctx, Layout.stepsPadX), 0)
        listOf(hand.step1, OnboardingContent.HAND_STEP_2, OnboardingContent.HAND_STEP_3).forEachIndexed { i, s ->
            addView(AshUi.text(ctx, "${i + 1}　$s", handStep))
        }
    }

    /** A centred vertical stack, [gapDp] between its children. */
    fun column(ctx: Context, gapDp: Int = 0) = AshUi.vstack(ctx, gapDp).apply { gravity = Gravity.CENTER_HORIZONTAL }

    fun fill(): LinearLayout.LayoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)

    fun frame(): FrameLayout.LayoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
}
