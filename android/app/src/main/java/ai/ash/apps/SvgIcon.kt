package ai.ash.apps

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import androidx.core.graphics.PathParser

/**
 * An app's icon that is an SVG file (the first-party apps' icons are: `icon.svg`, a rounded square and a path or two) drawn as a bitmap,
 * since Android decodes no SVG itself. Only what such an icon holds: `rect` (with `rx`), `circle`, `path` (any path data, arcs
 * included), `fill`, `stroke`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `opacity`, on the element itself, in a `viewBox`.
 * Anything else in the file is ignored; a file with no drawable shape gives no icon.
 */
object SvgIcon {
    class Shape(val tag: String, val attrs: Map<String, String>)
    class Parsed(val width: Float, val height: Float, val shapes: List<Shape>)

    private val element = Regex("<(rect|circle|path)\\b([^>]*?)/?>", RegexOption.IGNORE_CASE)
    private val attribute = Regex("([A-Za-z:-]+)\\s*=\\s*\"([^\"]*)\"")

    /** The view box (or width and height) and the shapes in drawing order; null when there is nothing to draw. */
    fun parse(svg: String): Parsed? {
        val root = Regex("<svg\\b([^>]*)>", RegexOption.IGNORE_CASE).find(svg) ?: return null
        val rootAttrs = attributes(root.groupValues[1])
        val box = rootAttrs["viewBox"]?.trim()?.split(Regex("[\\s,]+"))?.mapNotNull { it.toFloatOrNull() }?.takeIf { it.size == 4 }
        val width = box?.get(2) ?: rootAttrs["width"]?.toFloatOrNull() ?: return null
        val height = box?.get(3) ?: rootAttrs["height"]?.toFloatOrNull() ?: return null
        if (width <= 0f || height <= 0f) return null
        val shapes = element.findAll(svg).map { Shape(it.groupValues[1].lowercase(), attributes(it.groupValues[2])) }.toList()
        return if (shapes.isEmpty()) null else Parsed(width, height, shapes)
    }

    private fun attributes(text: String): Map<String, String> = attribute.findAll(text).associate { it.groupValues[1] to it.groupValues[2] }

    /** `#rgb`, `#rrggbb`, `#rrggbbaa` or a few names; null for `none` or what is not a colour. */
    fun color(text: String?): Int? {
        val t = text?.trim()?.lowercase() ?: return null
        return when {
            t == "none" || t.isEmpty() -> null
            t == "white" -> Color.WHITE
            t == "black" -> Color.BLACK
            t.startsWith("#") && t.length == 4 -> t.drop(1).map { "$it$it" }.joinToString("").toIntOrNull(16)?.let { 0xFF000000.toInt() or it }
            t.startsWith("#") && t.length == 7 -> t.drop(1).toIntOrNull(16)?.let { 0xFF000000.toInt() or it }
            t.startsWith("#") && t.length == 9 -> t.substring(1, 7).toIntOrNull(16)?.let { rgb -> ((t.substring(7).toInt(16) shl 24) or rgb) }
            else -> null
        }
    }

    /** The icon as a square bitmap [size] px wide; null when the file cannot be drawn. */
    fun render(svg: String, size: Int = 192): Bitmap? = runCatching {
        val p = parse(svg) ?: return null
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        canvas.scale(size / p.width, size / p.height)
        for (s in p.shapes) {
            val a = s.attrs
            val alpha = (a["opacity"]?.toFloatOrNull() ?: 1f).coerceIn(0f, 1f)
            fun num(key: String) = a[key]?.toFloatOrNull() ?: 0f
            fun draw(path: (Canvas, Paint) -> Unit) {
                val fill = if (a.containsKey("fill")) color(a["fill"]) else Color.BLACK
                if (fill != null) path(canvas, Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; this.color = fill; this.alpha = (Color.alpha(fill) * alpha).toInt() })
                color(a["stroke"])?.let { stroke ->
                    path(canvas, Paint(Paint.ANTI_ALIAS_FLAG).apply {
                        style = Paint.Style.STROKE; color = stroke; this.alpha = (Color.alpha(stroke) * alpha).toInt(); strokeWidth = a["stroke-width"]?.toFloatOrNull() ?: 1f
                        strokeCap = when (a["stroke-linecap"]) { "round" -> Paint.Cap.ROUND; "square" -> Paint.Cap.SQUARE; else -> Paint.Cap.BUTT }
                        strokeJoin = when (a["stroke-linejoin"]) { "round" -> Paint.Join.ROUND; "bevel" -> Paint.Join.BEVEL; else -> Paint.Join.MITER }
                    })
                }
            }
            when (s.tag) {
                "rect" -> { val rx = a["rx"]?.toFloatOrNull() ?: a["ry"]?.toFloatOrNull() ?: 0f; val ry = a["ry"]?.toFloatOrNull() ?: rx
                    val r = RectF(num("x"), num("y"), num("x") + num("width"), num("y") + num("height")); draw { c, paint -> c.drawRoundRect(r, rx, ry, paint) } }
                "circle" -> draw { c, paint -> c.drawCircle(num("cx"), num("cy"), num("r"), paint) }
                "path" -> a["d"]?.let { d -> PathParser.createPathFromPathData(d)?.let { path -> draw { c, paint -> c.drawPath(path, paint) } } }
            }
        }
        out
    }.getOrNull()
}
