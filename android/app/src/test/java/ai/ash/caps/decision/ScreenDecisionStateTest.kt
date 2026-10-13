package ai.ash.caps.decision

import org.junit.Assert.*
import org.junit.Test

class ScreenDecisionStateTest {
    @Test fun newTurnInvalidatesOldCleanupAndRetriesCannotReturnTwice() {
        val state = ScreenDecisionState()
        state.beginTurn("t1")
        assertTrue(state.mayReturn("d1", "t1"))
        state.applied("d1")
        assertFalse(state.mayReturn("d1", "t1"))
        state.beginTurn("t2")
        assertFalse(state.mayReturn("d2", "t1"))
    }
}
