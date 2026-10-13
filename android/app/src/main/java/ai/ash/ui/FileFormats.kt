package ai.ash.ui

import org.json.JSONTokener
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/**
 * What a file is, for the viewer: how it is shown is decided by its name's ending, then by the type the body gave, then by what
 * its first bytes look like. Pure functions, no views (the views are in [FilePreviews] and [FileViewer]).
 */
object FileFormats {
    enum class Kind { IMAGE, PDF, AUDIO, VIDEO, TABLE, JSON, MARKDOWN, HTML, TEXT, OTHER }

    private val IMAGES = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif")
    private val AUDIO = setOf("mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "amr", "mid", "midi")
    private val VIDEO = setOf("mp4", "m4v", "webm", "mkv", "3gp", "mov")
    private val TABLES = setOf("csv", "tsv")
    private val JSON = setOf("json", "geojson", "webmanifest")
    private val MARKDOWN = setOf("md", "markdown")
    private val HTML = setOf("html", "htm", "xhtml")
    private val TEXTS = setOf(
        "txt", "text", "log", "out", "ini", "cfg", "conf", "config", "properties", "env", "toml", "yaml", "yml", "xml", "svg", "plist",
        "js", "mjs", "cjs", "jsx", "ts", "tsx", "css", "scss", "sass", "less", "vue", "svelte", "jsonl", "ndjson",
        "py", "pyi", "rb", "go", "rs", "java", "kt", "kts", "scala", "groovy", "gradle", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs",
        "m", "mm", "swift", "dart", "lua", "php", "pl", "pm", "r", "jl", "sh", "bash", "zsh", "fish", "bat", "cmd", "ps1",
        "sql", "graphql", "proto", "tex", "rst", "adoc", "org", "srt", "vtt", "diff", "patch", "lock", "mk", "cmake", "tf",
        "gitignore", "gitattributes", "editorconfig", "dockerfile", "makefile",
    )
    /** Known to need another application: not read just to be looked at. */
    private val OTHERS = setOf(
        "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "pages", "numbers", "key",
        "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "apk", "aab", "exe", "dmg", "iso", "bin", "so", "dll", "jar", "class",
        "epub", "mobi", "ttf", "otf", "woff", "woff2", "db", "sqlite", "psd",
    )

    /** The kind a name's ending says, or null when the ending says nothing. */
    fun kindOfName(ext: String): Kind? = when (ext.lowercase()) {
        in IMAGES -> Kind.IMAGE
        "pdf" -> Kind.PDF
        in AUDIO -> Kind.AUDIO
        in VIDEO -> Kind.VIDEO
        in TABLES -> Kind.TABLE
        in JSON -> Kind.JSON
        in MARKDOWN -> Kind.MARKDOWN
        in HTML -> Kind.HTML
        in TEXTS -> Kind.TEXT
        in OTHERS -> Kind.OTHER
        else -> null
    }

    /** The kind of a file: by its ending, then by [mime], then by its bytes (UTF-8 text is text, whatever it is called). */
    fun kind(ext: String, mime: String?, data: ByteArray): Kind {
        kindOfName(ext)?.let { return it }
        val type = mime?.lowercase().orEmpty()
        when {
            type.startsWith("image/") && type != "image/svg+xml" -> return Kind.IMAGE
            type == "application/pdf" -> return Kind.PDF
            type.startsWith("audio/") -> return Kind.AUDIO
            type.startsWith("video/") -> return Kind.VIDEO
        }
        return if (looksLikeText(data)) Kind.TEXT else Kind.OTHER
    }

    /** True when the first 8 KiB hold no NUL and are UTF-8 (a character cut by the sample's end is not a fault). */
    fun looksLikeText(data: ByteArray): Boolean {
        val n = minOf(data.size, 8192)
        for (i in 0 until n) if (data[i].toInt() == 0) return false
        val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        val result = decoder.decode(ByteBuffer.wrap(data, 0, n), java.nio.CharBuffer.allocate(n + 1), data.size <= n)
        return !result.isError
    }

    /** At most [max] bytes of [data] as text (without a byte order mark); true when the file went on. */
    fun preview(data: ByteArray, max: Int = TEXT_PREVIEW_BYTES): Pair<String, Boolean> {
        val cut = data.size > max
        var s = String(data, 0, minOf(data.size, max), Charsets.UTF_8)
        if (cut) s = s.trimEnd('�')
        return s.removePrefix("﻿") to cut
    }

    const val TEXT_PREVIEW_BYTES = 1024 * 1024

    class Table(val rows: List<List<String>>, val moreRows: Boolean, val moreColumns: Boolean)

    /** Delimited text as rows of cells (quotes, doubled quotes and line breaks inside quotes as in CSV), at most [maxRows] x [maxColumns]. */
    fun parseDelimited(text: String, delimiter: Char, maxRows: Int, maxColumns: Int): Table {
        val rows = ArrayList<List<String>>()
        var row = ArrayList<String>()
        val cell = StringBuilder()
        var quoted = false
        var moreColumns = false
        fun endCell() { if (row.size < maxColumns) row.add(cell.toString()) else moreColumns = true; cell.setLength(0) }
        /** True when [maxRows] is reached. A blank line is no row. */
        fun endRow(): Boolean {
            endCell()
            if (!(row.size == 1 && row[0].isEmpty())) rows.add(row)
            row = ArrayList()
            return rows.size >= maxRows
        }
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (quoted) {
                if (c == '"') { if (i + 1 < text.length && text[i + 1] == '"') { cell.append('"'); i++ } else quoted = false } else cell.append(c)
            } else when {
                c == '"' && cell.isEmpty() -> quoted = true
                c == delimiter -> endCell()
                c == '\r' -> {}
                c == '\n' -> if (endRow()) return Table(rows, (i + 1 until text.length).any { !text[it].isWhitespace() }, moreColumns)
                else -> cell.append(c)
            }
            i++
        }
        if (cell.isNotEmpty() || row.isNotEmpty()) endRow()
        return Table(rows, false, moreColumns)
    }

    /** JSON text laid out with two-space indents and its values exactly as written; null when it is not JSON. */
    fun prettyJson(text: String): String? {
        val tokener = JSONTokener(text)
        val valid = runCatching { tokener.nextValue(); tokener.nextClean() == 0.toChar() }.getOrDefault(false)
        if (!valid) return null
        val out = StringBuilder(text.length * 2)
        var depth = 0
        var inString = false
        var escaped = false
        fun newline() { out.append('\n'); repeat(depth) { out.append("  ") } }
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (inString) {
                out.append(c)
                if (escaped) escaped = false else if (c == '\\') escaped = true else if (c == '"') inString = false
            } else when (c) {
                '"' -> { inString = true; out.append(c) }
                '{', '[' -> {
                    out.append(c)
                    val close = if (c == '{') '}' else ']'
                    var j = i + 1
                    while (j < text.length && text[j].isWhitespace()) j++
                    if (j < text.length && text[j] == close) { out.append(close); i = j } else { depth++; newline() }
                }
                '}', ']' -> { depth--; newline(); out.append(c) }
                ',' -> { out.append(c); newline() }
                ':' -> out.append(": ")
                ' ', '\t', '\n', '\r' -> {}
                else -> out.append(c)
            }
            i++
        }
        return out.toString()
    }
}
