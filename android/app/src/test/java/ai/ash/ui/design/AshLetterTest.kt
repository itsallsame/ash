package ai.ash.ui.design

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The letter face follows the same vectors as the web page's (design/app/letter-avatar-vectors.json). */
class AshLetterTest {
    private fun read(rel: String) = JSONObject(listOf("../../$rel", rel).map(::File).first { it.exists() }.readText())
    private val cases = read("design/app/letter-avatar-vectors.json").getJSONArray("cases")

    @Test fun letterAndToneFollowTheSharedVectors() {
        assertTrue(cases.length() >= 15)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            assertEquals("letter of '$name'", c.getString("letter"), AshLetter.letterOf(name))
            assertEquals("tone of '$name'", c.getInt("tone"), AshLetter.toneIndex(name))
        }
    }

    @Test fun missingNameIsAQuestionMarkOnTheFirstColour() {
        assertEquals("?", AshLetter.letterOf(null))
        assertEquals(0, AshLetter.toneIndex(null))
    }

    @Test fun sixColoursInTheTablesOrderSameInLightAndDark() {
        val table = listOf(0xFF6B5BD6, 0xFF2F73C9, 0xFF14837A, 0xFF3A8540, 0xFFA8641A, 0xFFB5456C).map { it.toInt() }
        for (p in listOf(AshTokens.light, AshTokens.dark)) {
            val got = (0 until 6).map { colourOfTone(p, it) }
            assertEquals(table, got)
        }
        assertEquals(AshTokens.light.onHelper, AshTokens.dark.onHelper)
    }

    // a name whose code points sum to [tone] mod 6: the character whose code is 0x30 + tone ('0'..'5' = 48..53; 48 % 6 == 0)
    private fun colourOfTone(p: AshPalette, tone: Int): Int = AshLetter.color(p, (48 + tone).toChar().toString())

    @Test fun whiteTextReadsOnEveryColour() {
        fun lum(c: Int): Double = listOf(16, 8, 0).map { ((c shr it) and 0xFF) / 255.0 }.map { if (it <= 0.03928) it / 12.92 else Math.pow((it + 0.055) / 1.055, 2.4) }.let { 0.2126 * it[0] + 0.7152 * it[1] + 0.0722 * it[2] }
        val p = AshTokens.light
        for (c in listOf(p.helperPurple, p.helperBlue, p.helperTeal, p.helperGreen, p.helperAmber, p.helperRose))
            assertTrue("contrast ${Integer.toHexString(c)}", 1.05 / (lum(c) + 0.05) >= 4.5)
        // the primary colour, which carries white text in the light theme: the designer's measured 4.55
        assertTrue(1.05 / (lum(p.you) + 0.05) >= 4.5)
    }
}
