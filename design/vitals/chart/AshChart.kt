package ai.ash.widget

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * A2UI `Chart`（Ash 扩展）的原生画法：几何和 design/app/vitals/chart/chart.mjs 一模一样，画成位图放进小组件的 ImageView。
 *
 * 参考实现，没在本机编译过（这个仓库的沙箱拿不到 Android SDK）。接法：
 * - card.ts 的 FIELDS 加 `Chart: ["series", "gap"]`、CARD_COMPONENTS 加 "Chart"、IMPOSSIBLE 去掉 Chart，并校验 series（见 HANDOFF §8）；
 * - CardViews 遇到 Chart：按这个节点实际的宽高（dp）× 密度 调 [render]，颜色用卡片现有的取色（{light,dark} 按暗色挑），
 *   结果走 setImageViewBitmap，并计入已有的位图预算 bitmapBytes；
 * - 单测：读 vectors.json，逐个比 [layout] 的图元（坐标允许 ±0.05）。
 *
 * 单位：layout 里全是 dp；render 时整体乘 density。
 */
object AshChart {
    const val LINE_WIDTH = 1.6f
    const val AREA_ALPHA = 0.16f
    const val DOT = 2.4f
    const val PAD = 2f
    const val LIMIT_WIDTH = 1f
    val LIMIT_DASH = floatArrayOf(2f, 3f)
    const val BAR_RADIUS = 2f
    const val BAR_MIN = 2f
    const val GAP = 2f

    /** 一段高亮：to == null 表示一直到最后（正在越界）。颜色是已经按主题挑好的 ARGB。 */
    data class Highlight(val from: Int, val to: Int?, val color: Int)

    data class Series(
        val type: String,                 // "line" | "bars"
        val values: FloatArray,
        val color: Int,
        val fill: Boolean = false,
        val width: Float? = null,
        val dot: Boolean = true,
        val max: Float? = null,
        val floor: Float? = null,
        val highlight: Highlight? = null,
        val colors: Map<Int, Int> = emptyMap(),
        val lastColor: Int? = null,
        val limit: Float? = null,
        val limitColor: Int? = null,
    )

    data class Chart(val series: List<Series>, val gap: Float? = null)

    sealed class Prim {
        data class Bar(val x: Float, val y: Float, val w: Float, val h: Float, val r: Float, val color: Int) : Prim()
        data class Area(val points: List<FloatArray>, val color: Int, val alpha: Float) : Prim()
        data class Line(val points: List<FloatArray>, val color: Int, val width: Float) : Prim()
        data class Limit(val y: Float, val x1: Float, val x2: Float, val color: Int) : Prim()
        data class Dot(val x: Float, val y: Float, val r: Float, val color: Int) : Prim()
    }

    private fun r1(v: Float): Float = (v * 10f).roundToInt() / 10f

    fun scaleMax(s: Series): Float {
        s.max?.let { return it }
        val top = max(0f, s.values.maxOrNull() ?: 0f) * 1.25f
        val m = max(s.floor ?: 0f, top)
        return if (m == 0f) 1f else m
    }

    fun linePoints(values: FloatArray, w: Float, h: Float, max: Float): List<FloatArray> {
        val n = values.size
        return values.mapIndexed { i, v ->
            val x = if (n == 1) w else i.toFloat() / (n - 1) * w
            val c = min(max(v, 0f), max)
            floatArrayOf(r1(x), r1(h - PAD - c / max * (h - PAD * 2)))
        }
    }

    fun limitY(value: Float, h: Float, max: Float, bars: Boolean): Float {
        val c = min(value, max)
        return r1(if (bars) h - c / max * h else h - PAD - c / max * (h - PAD * 2))
    }

    /** 图元，按画的顺序：先面积 / 线 / 柱（按 series 顺序），再虚线，最后点。 */
    fun layout(chart: Chart, w: Float, h: Float): List<Prim> {
        val body = ArrayList<Prim>(); val limits = ArrayList<Prim>(); val dots = ArrayList<Prim>()
        for (s in chart.series) {
            val mx = scaleMax(s); val n = s.values.size
            if (s.type == "bars") {
                val gap = chart.gap ?: GAP
                val bw = (w - gap * (n - 1)) / n
                s.values.forEachIndexed { i, v ->
                    val bh = max(BAR_MIN, min(max(v, 0f), mx) / mx * h)
                    val color = s.colors[i] ?: (if (i == n - 1) s.lastColor else null) ?: s.color
                    val rw = r1(bw)
                    body += Prim.Bar(r1(i * (bw + gap)), r1(h - bh), rw, r1(bh), min(BAR_RADIUS, rw / 2), color)
                }
            } else {
                val pts = linePoints(s.values, w, h, mx)
                val width = s.width ?: LINE_WIDTH
                if (s.fill) body += Prim.Area(pts, s.color, AREA_ALPHA)
                body += Prim.Line(pts, s.color, width)
                var dotColor = s.color
                s.highlight?.let { hl ->
                    val end = (hl.to?.plus(1)) ?: n
                    val seg = pts.subList(hl.from, end)
                    if (s.fill) body += Prim.Area(seg, hl.color, AREA_ALPHA)
                    body += Prim.Line(seg, hl.color, r1(width + 0.4f))
                    if (hl.to == null) dotColor = hl.color
                }
                if (s.dot) dots += Prim.Dot(pts[n - 1][0], pts[n - 1][1], DOT, dotColor)
            }
            s.limit?.let { limits += Prim.Limit(limitY(it, h, mx, s.type == "bars"), 0f, w, s.limitColor ?: s.color) }
        }
        return body + limits + dots
    }

    /** 画成位图。wDp/hDp = 这个节点在小组件里实际的大小；density = 屏幕密度。透明底，卡片背景照常。 */
    fun render(chart: Chart, wDp: Float, hDp: Float, density: Float): Bitmap {
        val wPx = max(1, (wDp * density).roundToInt()); val hPx = max(1, (hDp * density).roundToInt())
        val bmp = Bitmap.createBitmap(wPx, hPx, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.scale(density, density)
        val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
        val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND; strokeCap = Paint.Cap.ROUND }
        fun path(points: List<FloatArray>) = Path().apply { points.forEachIndexed { i, p -> if (i == 0) moveTo(p[0], p[1]) else lineTo(p[0], p[1]) } }
        for (p in layout(chart, wDp, hDp)) when (p) {
            is Prim.Bar -> { fill.color = p.color; c.drawRoundRect(RectF(p.x, p.y, p.x + p.w, p.y + p.h), p.r, p.r, fill) }
            is Prim.Area -> {
                val a = path(p.points).apply { lineTo(p.points.last()[0], hDp); lineTo(p.points.first()[0], hDp); close() }
                fill.color = withAlpha(p.color, p.alpha); c.drawPath(a, fill)
            }
            is Prim.Line -> { stroke.color = p.color; stroke.strokeWidth = p.width; stroke.pathEffect = null; c.drawPath(path(p.points), stroke) }
            is Prim.Limit -> {
                stroke.color = p.color; stroke.strokeWidth = LIMIT_WIDTH; stroke.pathEffect = DashPathEffect(LIMIT_DASH, 0f)
                stroke.strokeCap = Paint.Cap.BUTT; c.drawLine(p.x1, p.y, p.x2, p.y, stroke); stroke.strokeCap = Paint.Cap.ROUND
            }
            is Prim.Dot -> { fill.color = p.color; c.drawCircle(p.x, p.y, p.r, fill) }
        }
        return bmp
    }

    /** 过期时外框把整张卡变灰：所有颜色换成 text-3（柱子的 surface-3 不变），高亮去掉。 */
    fun stale(chart: Chart, text3: Int, surface3: Int): Chart = chart.copy(series = chart.series.map { s ->
        val gray = if (s.type == "bars" && s.color == surface3) surface3 else text3
        s.copy(color = gray, highlight = null, colors = emptyMap(), lastColor = s.lastColor?.let { text3 }, limit = null)
    })

    private fun withAlpha(color: Int, alpha: Float): Int {
        val a = floor(((color ushr 24) and 0xFF) * alpha).toInt()
        return (a shl 24) or (color and 0x00FFFFFF)
    }
}
