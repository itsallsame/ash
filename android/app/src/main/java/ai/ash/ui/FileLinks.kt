package ai.ash.ui

import java.io.ByteArrayOutputStream

/**
 * A file the kernel names: [workspace] says which body (`main`, a computer body's id, or the full `body:` id) and [path] is a path on
 * it, relative to its work directory (an absolute path is fine for a link in a message). The rules are the web page's cards.js and files.js.
 */
data class FileRef(val workspace: String, val path: String, val name: String? = null) {
    val baseName get() = name?.takeIf { it.isNotEmpty() } ?: path.substringAfterLast('/')
    val directory get() = path.substringBeforeLast('/', "")
    /** The body this file is on, or null when the page does not know it (it is never guessed to be the main one). */
    val body get() = FileLinks.bodyOf(workspace)
}

object FileLinks {
    const val MAX_READ_BYTES = 20 * 1024 * 1024
    val IMAGES = setOf("png", "jpg", "jpeg", "gif", "webp")
    val TEXTS = setOf("md", "markdown", "txt", "json", "csv", "log", "js", "ts", "css", "py", "yaml", "yml", "xml")
    val HTML = setOf("html", "htm")

    private val WORKSPACE = Regex("[A-Za-z0-9:_-]+")
    private val BODY_ID = Regex("body:(main|[A-Za-z0-9_-]{22})")

    /** The ref when [workspace] and [path] are a plain path on a body; null otherwise. */
    fun ref(workspace: String?, path: String?, name: String? = null): FileRef? {
        if (workspace == null || path == null || !WORKSPACE.matches(workspace) || path.isEmpty() || '\\' in path || '\u0000' in path || "//" in path) return null
        val parts = path.removePrefix("/").split('/')
        if (parts.any { it.isEmpty() || it == "." || it == ".." }) return null
        return FileRef(workspace, path, name)
    }

    fun bodyOf(workspace: String): String? = when {
        BODY_ID.matches(workspace) -> workspace
        BODY_ID.matches("body:$workspace") -> "body:$workspace"
        else -> null
    }

    fun extension(path: String): String = path.substringAfterLast('.', "").lowercase()

    /**
     * Where a link in a message points: a path on a body, resolved against the file the link is in. A path that climbs out of the
     * directory, or anything that is not a plain path (a URL, a script, a fragment), is nothing to open.
     */
    fun resolve(href: String?, base: FileRef = FileRef("main", "")): FileRef? {
        if (href == null || href.any { it == '\\' || it.code < 32 || it.code == 127 } || href.startsWith("//") || href.startsWith("#") || Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(href)) return null
        var path = percentDecode(href.substringBefore('#')) ?: return null
        val absolute = path.startsWith("/")
        if (!absolute) path = (if ('/' in base.path) base.path.substring(0, base.path.lastIndexOf('/') + 1) else "") + path
        val parts = ArrayList<String>()
        for (part in path.split('/')) {
            if (part.isEmpty() || part == ".") continue
            if (part == "..") { if (absolute || parts.isEmpty()) return null; parts.removeAt(parts.size - 1) } else parts.add(part)
        }
        return ref(base.workspace, (if (absolute) "/" else "") + parts.joinToString("/"))
    }

    /** `decodeURIComponent`: null when a % is not followed by two hex digits or the bytes are not UTF-8. */
    fun percentDecode(s: String): String? {
        if ('%' !in s) return s
        val out = ByteArrayOutputStream()
        var i = 0
        while (i < s.length) {
            if (s[i] == '%') {
                val hex = s.substring(i + 1, minOf(i + 3, s.length))
                if (hex.length != 2 || hex.any { Character.digit(it, 16) < 0 }) return null
                out.write(hex.toInt(16)); i += 3
            } else {
                val cp = s.codePointAt(i)
                out.write(String(Character.toChars(cp)).toByteArray(Charsets.UTF_8)); i += Character.charCount(cp)
            }
        }
        return runCatching { Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(out.toByteArray())).toString() }.getOrNull()
    }
}
