package ai.ash.apps

import android.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class SvgIconTest {
    private val vitals = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"><rect width="108" height="108" rx="24" fill="#2E2420"/><path d="M15 54h17l11-26 22 52 11-26h17" fill="none" stroke="#4CC7BE" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>"""

    @Test fun theShapesAndTheViewBoxOfAnAppIcon() {
        val p = SvgIcon.parse(vitals)!!
        assertEquals(108f, p.width); assertEquals(108f, p.height)
        assertEquals(listOf("rect", "path"), p.shapes.map { it.tag })
        assertEquals("24", p.shapes[0].attrs["rx"])
        assertEquals("round", p.shapes[1].attrs["stroke-linecap"])
        assertEquals("M15 54h17l11-26 22 52 11-26h17", p.shapes[1].attrs["d"])
    }

    @Test fun widthAndHeightWhenThereIsNoViewBox() {
        val p = SvgIcon.parse("""<svg width="24" height="12"><circle cx="6" cy="6" r="5"/></svg>""")!!
        assertEquals(24f, p.width); assertEquals(12f, p.height)
    }

    @Test fun nothingToDrawIsNoIcon() {
        assertNull(SvgIcon.parse("""<svg viewBox="0 0 10 10"><g/></svg>"""))
        assertNull(SvgIcon.parse("""<svg viewBox="0 0 0 0"><rect width="1" height="1"/></svg>"""))
        assertNull(SvgIcon.parse("not an svg"))
        assertNotNull(SvgIcon.parse(vitals))
    }

    @Test fun colours() {
        assertEquals(0xFF2E2420.toInt(), SvgIcon.color("#2E2420"))
        assertEquals(0xFFFFFFFF.toInt(), SvgIcon.color("#fff"))
        assertEquals(Color.WHITE, SvgIcon.color("white"))
        assertNull(SvgIcon.color("none"))
        assertNull(SvgIcon.color("url(#gradient)"))
        assertNull(SvgIcon.color(null))
    }
}
