package ai.ash.ui

import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.text.style.BulletSpan
import android.text.style.LeadingMarginSpan
import android.text.style.QuoteSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.ClickableSpan
import android.text.style.URLSpan
import android.view.View

/**
 * The Markdown of chat messages, as spans (the web page's markdown.js, same subset): headings, **bold**, *italic*,
 * ~~strike~~, `code`, fenced code blocks, - / 1. lists, > quotes, [links](url) and bare http(s) links. Nothing is fetched;
 * links open only when tapped.
 */
object Md {
    private val inline = Regex("""\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|`([^`]+)`|\[([^\]]+)]\(([^)\s]+)\)|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)|(https?://[^\s<>()]+[^\s<>().,;:!?'"])""")

    fun render(src: String, codeBg: Int, quote: Int, onFileLink: ((String) -> Unit)? = null): Spanned {
        val out = SpannableStringBuilder()
        val lines = src.replace("\r\n", "\n").split("\n")
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            if (line.trimStart().startsWith("```")) {
                val body = StringBuilder()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) { if (body.isNotEmpty()) body.append('\n'); body.append(lines[i]); i++ }
                i++
                block(out) { val s = out.length; out.append(body); out.setSpan(TypefaceSpan("monospace"), s, out.length, X); out.setSpan(BackgroundColorSpan(codeBg), s, out.length, X) }
                continue
            }
            val heading = Regex("^(#{1,6})\\s+(.*)").find(line)
            val bullet = Regex("^\\s*[-*+]\\s+(.*)").find(line)
            val numbered = Regex("^\\s*(\\d+)[.)]\\s+(.*)").find(line)
            val quoted = Regex("^>\\s?(.*)").find(line)
            block(out) {
                val s = out.length
                when {
                    heading != null -> { spans(out, heading.groupValues[2], codeBg, onFileLink); out.setSpan(StyleSpan(Typeface.BOLD), s, out.length, X); out.setSpan(RelativeSizeSpan(if (heading.groupValues[1].length <= 2) 1.15f else 1.05f), s, out.length, X) }
                    bullet != null -> { spans(out, bullet.groupValues[1], codeBg, onFileLink); out.setSpan(BulletSpan(24), s, out.length, X) }
                    numbered != null -> { out.append(numbered.groupValues[1]).append(". "); spans(out, numbered.groupValues[2], codeBg, onFileLink); out.setSpan(LeadingMarginSpan.Standard(8, 40), s, out.length, X) }
                    quoted != null -> { spans(out, quoted.groupValues[1], codeBg, onFileLink); out.setSpan(QuoteSpan(quote), s, out.length, X) }
                    else -> spans(out, line, codeBg, onFileLink)
                }
            }
            i++
        }
        return out
    }

    /** The web page's test for a link that is a file path: no scheme, not `//`, not `#`, no control characters or backslash. */
    fun isFileLink(href: String) = href.isNotEmpty() && !Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:|^//|^#").containsMatchIn(href) && href.none { it == '\\' || it.code < 32 || it.code == 127 }

    private const val X = Spanned.SPAN_EXCLUSIVE_EXCLUSIVE

    private inline fun block(out: SpannableStringBuilder, body: () -> Unit) {
        if (out.isNotEmpty()) out.append('\n')
        body()
    }

    private fun spans(out: SpannableStringBuilder, text: String, codeBg: Int, onFileLink: ((String) -> Unit)?) {
        var at = 0
        for (m in inline.findAll(text)) {
            out.append(text, at, m.range.first)
            val s = out.length
            val g = m.groupValues
            when {
                g[1].isNotEmpty() || g[2].isNotEmpty() -> { spans(out, g[1].ifEmpty { g[2] }, codeBg, onFileLink); out.setSpan(StyleSpan(Typeface.BOLD), s, out.length, X) }
                g[3].isNotEmpty() -> { spans(out, g[3], codeBg, onFileLink); out.setSpan(StrikethroughSpan(), s, out.length, X) }
                g[4].isNotEmpty() -> { out.append(g[4]); out.setSpan(TypefaceSpan("monospace"), s, out.length, X); out.setSpan(BackgroundColorSpan(codeBg), s, out.length, X) }
                g[5].isNotEmpty() -> {
                    out.append(g[5])
                    val href = g[6]
                    when {
                        Regex("^(https?://|mailto:)", RegexOption.IGNORE_CASE).containsMatchIn(href) -> out.setSpan(URLSpan(href), s, out.length, X)
                        // A path (not a URL, a script or a fragment) names a file on a body: the viewer opens it.
                        onFileLink != null && isFileLink(href) -> out.setSpan(object : ClickableSpan() { override fun onClick(w: View) = onFileLink(href) }, s, out.length, X)
                    }
                }
                g[7].isNotEmpty() -> { spans(out, g[7], codeBg, onFileLink); out.setSpan(StyleSpan(Typeface.ITALIC), s, out.length, X) }
                g[8].isNotEmpty() -> { out.append(g[8]); out.setSpan(URLSpan(g[8]), s, out.length, X) }
            }
            at = m.range.last + 1
        }
        out.append(text, at, text.length)
    }
}
