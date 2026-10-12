package ai.ash.kernel.host

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingInputTest {
    @Test fun keepsLeadingZeroAndAcceptsWhitespaceAroundTheSystemCode() {
        assertTrue(GuideService.validCode("001234"))
        assertTrue(GuideService.validCode(" 012345\n"))
    }

    @Test fun rejectsPartialCodesLettersAndTheOldEightCharacterAcceptance() {
        listOf("", "12345", "1234567", "12345678", "12 3456", "abcdef", "１２３４５６").forEach {
            assertFalse(it, GuideService.validCode(it))
        }
    }
}
