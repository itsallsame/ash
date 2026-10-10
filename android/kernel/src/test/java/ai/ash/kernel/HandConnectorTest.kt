package ai.ash.kernel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HandConnectorTest {
    private class FakeLink : HandLink {
        var binds = 0
        var unbinds = 0
        var installed = true
        override fun bind(): Boolean { binds++; return installed }
        override fun unbind() { unbinds++ }
    }

    private class ManualScheduler : Scheduler {
        class Task(val delay: Long, val run: () -> Unit) { var cancelled = false }
        val tasks = ArrayList<Task>()
        override fun schedule(delayMs: Long, task: () -> Unit): () -> Unit {
            val t = Task(delayMs, task)
            tasks += t
            return { t.cancelled = true }
        }
        /** Runs the newest pending task. */
        fun fire() { tasks.last { !it.cancelled }.also { it.cancelled = true }.run() }
        fun pendingDelays() = tasks.filter { !it.cancelled }.map { it.delay }
    }

    private class FakeRemote : HandRemote {
        val attaches = ArrayList<Triple<Int, String, String>>()
        var failing = false
        override fun attach(port: Int, token: String, kernelVersion: String) {
            if (failing) throw android.os.DeadObjectException()
            attaches += Triple(port, token, kernelVersion)
        }
    }

    private val link = FakeLink()
    private val sched = ManualScheduler()
    private val connector = HandConnector(link, sched, "0.4.0", connectWaitMs = 0)

    @Test fun startBindsAndTheConnectedHandGetsNothingUntilTheCoreHandsOver() {
        connector.start()
        assertEquals(1, link.binds)
        val hand = FakeRemote()
        connector.onConnected(hand)
        assertTrue(hand.attaches.isEmpty())
        assertEquals(listOf("ai.ash.agent"), connector.handoff(43555, "tok"))
        assertEquals(listOf(Triple(43555, "tok", "0.4.0")), hand.attaches)
    }

    @Test fun handoffBeforeTheBindingIsUpIsDeliveredWhenItComes() {
        // Not bound yet: handoff binds at once; nobody to deliver to yet.
        assertEquals(emptyList<String>(), connector.handoff(43555, "tok"))
        assertEquals(1, link.binds)
        val hand = FakeRemote()
        connector.onConnected(hand)
        assertEquals(listOf(Triple(43555, "tok", "0.4.0")), hand.attaches)
    }

    @Test fun aRestartedCoreHandsOverNewDetailsAndTheOldOnesAreForgotten() {
        connector.start()
        val hand = FakeRemote()
        connector.onConnected(hand)
        connector.handoff(1111, "old")
        connector.forget() // the core died
        connector.onLost()
        val again = FakeRemote()
        connector.onConnected(again)
        assertTrue("stale details are not given to a rebound hand", again.attaches.isEmpty())
        connector.handoff(2222, "new")
        assertEquals(listOf(Triple(2222, "new", "0.4.0")), again.attaches)
    }

    @Test fun reboundHandGetsTheCurrentDetailsAgain() {
        connector.start()
        val hand = FakeRemote()
        connector.onConnected(hand)
        connector.handoff(1111, "tok")
        connector.onLost()
        val again = FakeRemote()
        connector.onConnected(again)
        assertEquals(listOf(Triple(1111, "tok", "0.4.0")), again.attaches)
    }

    @Test fun lostBindingIsReboundAfter1_2_4_8_16_30_30_seconds() {
        connector.start()
        val seen = ArrayList<Long>()
        repeat(7) {
            connector.onLost()
            seen += sched.pendingDelays()
            sched.fire() // the retry binds again, but the hand never connects
        }
        assertEquals(listOf(1_000L, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000), seen)
        assertEquals(8, link.binds)
        assertTrue("each rebind unbinds the dead one first", link.unbinds >= 7)
    }

    @Test fun aSuccessfulConnectionResetsTheBackoff() {
        connector.start()
        connector.onLost(); sched.fire()
        connector.onLost(); sched.fire()
        connector.onConnected(FakeRemote())
        connector.onLost()
        assertEquals(listOf(1_000L), sched.pendingDelays())
    }

    @Test fun handNotInstalledIsTriedEveryFiveMinutes() {
        link.installed = false
        connector.start()
        assertEquals(listOf(300_000L), sched.pendingDelays())
        sched.fire()
        assertEquals(2, link.binds)
        assertEquals(listOf(300_000L), sched.pendingDelays())
        // Installed meanwhile: the next try binds, and a handoff does not wait for the timer.
        link.installed = true
        assertEquals(emptyList<String>(), connector.handoff(1, "t"))
        assertEquals(3, link.binds)
        assertTrue(sched.pendingDelays().isEmpty())
    }

    @Test fun anAttachThatFailsIsRetriedAfterTheRebind() {
        connector.start()
        val dying = FakeRemote().apply { failing = true }
        connector.onConnected(dying)
        assertEquals(emptyList<String>(), connector.handoff(5, "t"))
        connector.onLost()
        val fresh = FakeRemote()
        connector.onConnected(fresh)
        assertEquals(listOf(Triple(5, "t", "0.4.0")), fresh.attaches)
    }

    @Test fun stopUnbindsAndForgets() {
        connector.start()
        connector.onConnected(FakeRemote())
        connector.stop()
        assertEquals(1, link.unbinds)
        assertFalse(sched.pendingDelays().isNotEmpty())
    }

    @Test fun backoffFunction() {
        assertEquals(listOf(1_000L, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000), (0..6).map { HandConnector.backoffMs(it) })
    }
}
