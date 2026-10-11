package ai.ash.ui.design

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AshPageTest {
    /** A phone without a camera hole: the pill sits 8dp under the status bar and is 28dp high, so a bar's title must start below 36dp of page. */
    @Test fun aBarWithATitleStartsBelowThePillOnAPhoneWithoutACameraHole() {
        assertEquals(26f, AshPage.islandPaddingDp(bars = 24f, hole = 0f), 0.01f)   // 36 - 10: the title line (24 of 44) starts 10dp into the controls
        assertEquals(26f, AshPage.islandPaddingDp(bars = 30f, hole = 0f), 0.01f)   // the status bar's height does not matter: the pill hangs from its lower edge
    }

    /** With a camera hole the pill hugs the camera (5dp down, 34 high): a page that already clears the hole needs little or nothing. */
    @Test fun aCameraHoleTakesTheBarUpAndNeedsLessRoom() {
        assertEquals(0f, AshPage.islandPaddingDp(bars = 30f, hole = 30f), 0.01f)   // pill ends at 39, page starts at 30: 9 - 10 < 0
        assertTrue(AshPage.islandPaddingDp(bars = 24f, hole = 12f) in 0f..26f)
    }

    @Test fun neverNegative() {
        assertEquals(0f, AshPage.islandPaddingDp(bars = 80f, hole = 80f), 0f)
    }
}
