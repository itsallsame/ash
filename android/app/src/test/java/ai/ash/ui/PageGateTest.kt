package ai.ash.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class PageGateTest {
    @Test fun `the usual order, start then hello`() {
        val g = PageGate()
        assertEquals(PageGate.Started.NEW, g.started(true))
        val epoch = g.epoch
        assertNotEquals(0L, epoch)
        assertEquals(PageGate.Hello.ATTACH, g.hello("a"))
        assertEquals(epoch, g.epoch)
    }

    @Test fun `hello before the start event is taken, and the late start does not end the page`() {
        val g = PageGate()
        assertEquals(PageGate.Hello.ATTACH, g.hello("a"))
        val epoch = g.epoch
        assertNotEquals("a hello must not be dropped for want of a start event", 0L, epoch)
        assertEquals(PageGate.Started.SAME, g.started(true))
        assertEquals(epoch, g.epoch)
        // The next load is a new page again.
        assertEquals(PageGate.Started.NEW, g.started(true))
        assertNotEquals(epoch, g.epoch)
    }

    @Test fun `a page that asks again is not a new page`() {
        val g = PageGate()
        g.started(true)
        assertEquals(PageGate.Hello.ATTACH, g.hello("a"))
        val epoch = g.epoch
        assertEquals(PageGate.Hello.AGAIN, g.hello("a"))
        assertEquals(epoch, g.epoch)
    }

    @Test fun `a reload whose hello comes before its start event replaces the old page`() {
        val g = PageGate()
        g.started(true); g.hello("a")
        val first = g.epoch
        assertEquals(PageGate.Hello.REPLACE, g.hello("b"))
        assertNotEquals(first, g.epoch)
        val second = g.epoch
        assertEquals(PageGate.Started.SAME, g.started(true))
        assertEquals(second, g.epoch)
    }

    @Test fun `a reload in the usual order`() {
        val g = PageGate()
        g.started(true); g.hello("a")
        assertEquals(PageGate.Started.NEW, g.started(true))
        assertEquals(PageGate.Hello.ATTACH, g.hello("b"))
    }

    @Test fun `leaving the app's page switches everything off`() {
        val g = PageGate()
        g.started(true); g.hello("a")
        assertEquals(PageGate.Started.OFF, g.started(false))
        assertEquals(0L, g.epoch)
        // The next load of the app's page starts clean, even though an early hello was never matched.
        assertEquals(PageGate.Started.NEW, g.started(true))
    }
}
