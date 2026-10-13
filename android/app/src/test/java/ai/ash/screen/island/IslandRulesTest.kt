package ai.ash.screen.island

import org.junit.Assert.*
import org.junit.Test

class IslandRulesTest {
    @Test fun aQuestionOrApprovalWaitingOnTheOwnerOpensTheCard() {
        assertTrue(IslandRules.opensCard("ask", waitingOnOwner = true))
        assertTrue(IslandRules.opensCard("approval", waitingOnOwner = true))
    }

    @Test fun aStepOnlyTheOwnerCanTakeInAshOpensTheCard() {
        assertTrue(IslandRules.opensCard("in_app", waitingOnOwner = false))
    }

    @Test fun aReplyOrAnEndedTurnDoesNotOpenTheCardByItself() {
        for (kind in listOf("reply", "result", "incomplete", "stopped", "working", "thinking"))
            assertFalse(kind, IslandRules.opensCard(kind, waitingOnOwner = false))
    }

    @Test fun onlyOutcomesSettleAndNothingWaitingOnTheOwnerEverDoes() {
        for (kind in listOf("reply", "result", "incomplete", "stopped")) assertTrue(kind, IslandRules.settles(kind))
        for (kind in listOf("ask", "approval", "in_app", "working", "thinking", "listening")) assertFalse(kind, IslandRules.settles(kind))
        assertEquals(30_000L, IslandRules.SETTLE_MS)
    }

    @Test fun onlyAnOpenInputBoxIsTheOwnerTyping() {
        assertEquals(IslandRules.Step.OWNER_TYPING, IslandRules.stepFor(editing = true, attached = true))
        assertEquals(IslandRules.Step.OWNER_TYPING, IslandRules.stepFor(editing = true, attached = false))
        assertEquals(IslandRules.Step.WAIT_FOR_FRAMES, IslandRules.stepFor(editing = false, attached = true))
    }

    @Test fun anIslandThatIsNotOnScreenHasNothingToMoveAside() {
        assertEquals(IslandRules.Step.NOTHING_TO_MOVE, IslandRules.stepFor(editing = false, attached = false))
    }

    @Test fun aSlowMainThreadIsNotTheOwnerTyping() {
        assertTrue(IslandRules.mayRunAfterWait(editing = false))
        assertFalse(IslandRules.mayRunAfterWait(editing = true))
    }

    @Test fun ownerTypingIsAStateErrorOfItsOwnKind() {
        val e: IllegalStateException = OwnerTypingException("owner_input_busy: x")
        assertTrue(e is OwnerTypingException)
        assertFalse(IllegalStateException("other") is OwnerTypingException)
    }

    @Test fun aCardTheIslandOpenedGoesBackOnceAnswered() {
        // An approval answered: nothing waits on the owner, no answer in flight; the turn's end (reply or not) does not hold it open.
        for (kind in listOf("working", "thinking", "reply", "result", "incomplete", "stopped"))
            assertTrue(kind, IslandRules.closesWhenAnswered(openedByItself = true, formIsCard = true, kind = kind, waitingOnOwner = false, answerSending = false, editing = false))
    }

    @Test fun anEmptyReplyAfterTheAnswerDoesNotKeepAnEmptyPanelOpen() {
        // Same rule for the "reply" kind a finished turn without reply text gets.
        assertTrue(IslandRules.closesWhenAnswered(true, true, "reply", waitingOnOwner = false, answerSending = false, editing = false))
    }

    @Test fun aCardStaysWhileItIsStillWaitingBeingAnsweredOrTypedInto() {
        assertFalse(IslandRules.closesWhenAnswered(true, true, "working", waitingOnOwner = true, answerSending = false, editing = false))
        assertFalse(IslandRules.closesWhenAnswered(true, true, "working", waitingOnOwner = false, answerSending = true, editing = false))
        assertFalse(IslandRules.closesWhenAnswered(true, true, "ask", waitingOnOwner = false, answerSending = false, editing = true))
        assertFalse("a step in Ash still waits", IslandRules.closesWhenAnswered(true, true, "in_app", waitingOnOwner = false, answerSending = false, editing = false))
    }

    @Test fun aCardTheOwnerOpenedIsLeftToTheOwner() {
        assertFalse(IslandRules.closesWhenAnswered(openedByItself = false, formIsCard = true, kind = "reply", waitingOnOwner = false, answerSending = false, editing = false))
        assertFalse(IslandRules.closesWhenAnswered(openedByItself = true, formIsCard = false, kind = "reply", waitingOnOwner = false, answerSending = false, editing = false))
    }
}
