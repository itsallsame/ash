package ai.ash.apps

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class AppLampTest {
    private val now = 10_000_000L
    private fun status(vararg ok: Boolean) = JSONObject().put("invariants", JSONArray(ok.map { JSONObject().put("id", "x").put("ok", it) }))
    private fun breach(ago: Long) = JSONObject().put("type", "breach").put("id", "loop.lag").put("at", now - ago)

    @Test fun aBrokenBudgetNowIsAProblemWhateverElseThereIs() {
        assertEquals("err", AppLamp.level(false, status(true, false), listOf(breach(1000)), 3, now))
    }

    @Test fun anUnreadableKernelIsAProblemAndAPauseIsAPause() {
        assertEquals("err", AppLamp.level(false, null, null, null, now))
        assertEquals("paused", AppLamp.level(true, status(false), null, null, now))
    }

    @Test fun aBreachWithinTheLastHourOrSomethingThePhoneNeedsIsAWarning() {
        assertEquals("warn", AppLamp.level(false, status(true), listOf(breach(59 * 60_000L)), 0, now))
        assertEquals("ok", AppLamp.level(false, status(true), listOf(breach(61 * 60_000L)), 0, now))
        assertEquals("warn", AppLamp.level(false, status(true), emptyList(), 2, now))
        assertEquals("ok", AppLamp.level(false, status(true), emptyList(), 0, now))
        assertEquals("ok", AppLamp.level(false, status(true), null, null, now))
    }

    @Test fun anEndedBreachRecordIsNotABreach() {
        val ended = JSONObject().put("type", "ok").put("id", "loop.lag").put("at", now - 1000)
        assertEquals("ok", AppLamp.level(false, status(true), listOf(ended), 0, now))
    }
}
