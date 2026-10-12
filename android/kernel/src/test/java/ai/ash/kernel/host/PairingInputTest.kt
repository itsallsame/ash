package ai.ash.kernel.host

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingInputTest {
    @Test fun inputExistsBeforeAnyPortIsDiscoveredAndAfterAFailedAttempt() {
        assertTrue(PairingProgress(PairingStage.WAITING_CODE, pairingPort = 0, pairing = true).acceptsCode)
        assertTrue(PairingProgress(PairingStage.WAITING_CODE, pairingPort = 40001, pairing = true).acceptsCode)
        assertTrue(PairingProgress(PairingStage.ERROR, pairing = true).acceptsCode)
        assertFalse("a connection error is not a pairing session", PairingProgress(PairingStage.ERROR).acceptsCode)
    }

    @Test fun acceptedInputAndSuccessDoNotLeaveTheReplyActionSpinning() {
        listOf(PairingStage.PAIRING, PairingStage.CONNECTING, PairingStage.STARTING, PairingStage.READY).forEach {
            assertFalse(it.name, PairingProgress(it, pairing = true).acceptsCode)
        }
    }

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
