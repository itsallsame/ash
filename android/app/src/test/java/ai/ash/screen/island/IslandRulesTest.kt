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
}
