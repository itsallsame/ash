package ai.ash.ui.design

import java.text.BreakIterator

/**
 * The letter face of a helper agent: its first character on one of six colours chosen by its name. The web page does the
 * same with the same rules (design/app/letter-avatar-vectors.json is the test both share).
 */
object AshLetter {
    /** The first character of [name], whole (an emoji, a flag or a letter with its accent is never cut); "?" when the name is empty. */
    fun letterOf(name: String?): String {
        val trimmed = (name ?: "").trim()
        if (trimmed.isEmpty()) return "?"
        val it = BreakIterator.getCharacterInstance()
        it.setText(trimmed)
        val first = trimmed.substring(0, it.next().let { end -> if (end == BreakIterator.DONE) trimmed.length else end })
        return if (first.length == 1 && first[0] in 'a'..'z') first.uppercase() else first
    }

    /** 0..5, the position in the design's table: the sum of the code points of the trimmed [name], mod 6. */
    fun toneIndex(name: String?): Int {
        val trimmed = (name ?: "").trim()
        var sum = 0L
        var i = 0
        while (i < trimmed.length) { val cp = trimmed.codePointAt(i); sum += cp; i += Character.charCount(cp) }
        return (sum % 6).toInt()
    }

    /** The background colour of [name]'s face. Light and dark use the same six. */
    fun color(p: AshPalette, name: String?): Int = listOf(p.helperPurple, p.helperBlue, p.helperTeal, p.helperGreen, p.helperAmber, p.helperRose)[toneIndex(name)]
}
