package ai.ash.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Back from a settings page: the state is read at once and again at half a second, a second and a half and three seconds. */
class ReturnRecheckTest {
    /** A clock the test turns by hand: tasks run in the order of their time, as a handler's would. */
    private class Clock : ReturnRecheck.Scheduler {
        var now = 0L
        val waiting = mutableListOf<Pair<Long, Runnable>>()
        override fun postDelayed(task: Runnable, ms: Long) { waiting += (now + ms) to task }
        override fun cancel(task: Runnable) { waiting.removeAll { it.second === task } }
        fun advance(ms: Long) {
            val to = now + ms
            while (true) {
                val next = waiting.filter { it.first <= to }.minByOrNull { it.first } ?: break
                waiting.remove(next); now = next.first; next.second.run()
            }
            now = to
        }
    }

    private val clock = Clock()
    private val reads = mutableListOf<Long>()
    private val recheck = ReturnRecheck(clock) { reads += clock.now }

    @Test fun theSequenceIsAtOnceThenHalfASecondOneAndAHalfAndThree() {
        assertEquals(listOf(0L, 500L, 1_500L, 3_000L), ReturnRecheck.DELAYS_MS.toList())
        recheck.start()
        assertEquals("the first read is at once", listOf(0L), reads)
        clock.advance(10_000)
        assertEquals(listOf(0L, 500L, 1_500L, 3_000L), reads)
        assertTrue("nothing keeps reading afterwards", clock.waiting.isEmpty())
    }

    @Test fun comingBackAgainStartsTheSequenceOverWithoutTheOldOnesLeft() {
        recheck.start()
        clock.advance(600)                       // reads at 0 and 500
        recheck.start()                          // back again at 600: the 1.5 s and 3 s reads of the first run are dropped
        clock.advance(10_000)
        assertEquals(listOf(0L, 500L, 600L, 1_100L, 2_100L, 3_600L), reads)
    }

    @Test fun leavingStopsTheReads() {
        recheck.start()
        clock.advance(100)
        recheck.cancel()
        clock.advance(10_000)
        assertEquals(listOf(0L), reads)
    }
}
