package ai.ash.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/** What the ball, the bar and the notice read of a lease: the time left as m:ss. */
class LeaseStateTest {
    private fun lease(expires: Long) = LeaseState.Lease("ls_1", "agent:main", "ash", "timed", "给小王发消息", 0, expires)

    @Test fun theTimeLeftCountsDownAsMinutesAndSeconds() {
        assertEquals("14:58", lease(15 * 60_000L).clock(now = 2_000))
        assertEquals("0:59", lease(60_000L).clock(now = 1_000))
        assertEquals("0:00", lease(1_000L).clock(now = 5_000))
        assertEquals(0L, lease(1_000L).remaining(now = 5_000))
    }
}
