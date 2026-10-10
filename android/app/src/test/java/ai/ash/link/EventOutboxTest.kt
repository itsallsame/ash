package ai.ash.link

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Events are stored before they are sent, removed only on `event.ack`, and sent again (same id) after a reconnect. */
class EventOutboxTest {
    private val link = TestLink()
    @After fun end() = link.close()

    private fun body(n: Int) = JSONObject().put("level", n)
    private fun eventIds(conn: KernelConn) = conn.framesOf("event").map { it.getString("id") }

    @Test fun anEventIsStoredBeforeItIsSentAndKeptUntilAcked() {
        val conn = link.connect()
        assertTrue(link.client.emit("sense.battery", body(14), id = "e1", at = 123))
        val event = conn.awaitFrame("event")
        assertEquals("e1", event.getString("id"))
        assertEquals("device", event.getString("ch"))
        assertEquals("sense.battery", event.getString("word"))
        assertEquals(14, event.getJSONObject("body").getInt("level"))
        assertEquals(123L, event.getLong("at"))
        assertEquals(listOf("add e1"), link.store.log.toList())
        assertEquals(listOf("e1"), link.outbox.pending().map { it.id })

        conn.send(JSONObject().put("t", "event.ack").put("id", "e1"))
        awaitTrue("removed after the ack") { link.outbox.pending().isEmpty() }
        assertEquals(listOf("add e1", "remove e1"), link.store.log.toList())
    }

    @Test fun anEventEmittedWhileOfflineIsSentAfterTheHandshakeInOrder() {
        link.client.emit("sense.battery", body(1), id = "e1")
        link.client.emit("sense.battery", body(2), id = "e2")
        assertEquals(listOf("e1", "e2"), link.outbox.pending().map { it.id })
        val conn = link.connect()
        awaitTrue("both sent") { eventIds(conn).size == 2 }
        assertEquals(listOf("e1", "e2"), eventIds(conn))
    }

    @Test fun theManifestComesBeforeTheEvents() {
        link.client.setManifest(listOf(manifestCap()), emptyList())
        link.client.emit("sense.battery", body(1), id = "e1")
        val conn = link.connect()
        conn.awaitFrame("event")
        val order = conn.frames.map { it.getString("t") }
        assertTrue(order.indexOf("manifest") < order.indexOf("event"))
    }

    @Test fun anUnackedEventIsSentAgainWithTheSameIdAfterAReconnect() {
        val conn = link.connect()
        link.client.emit("sense.battery", body(1), id = "e1")
        link.client.emit("sense.battery", body(2), id = "e2")
        awaitTrue("sent") { eventIds(conn).size == 2 }
        conn.send(JSONObject().put("t", "event.ack").put("id", "e1"))
        awaitTrue("e1 acked") { link.outbox.pending().map { it.id } == listOf("e2") }

        conn.close(4500)
        link.clock.awaitTimer(1000); link.clock.advance(1000)
        val again = link.kernel.awaitConn(1)
        again.awaitFrame("hello"); again.welcome()
        assertEquals("e2", again.awaitFrame("event").getString("id"))
        assertEquals(2, again.awaitFrame("event").getJSONObject("body").getInt("level"))
        Thread.sleep(100)
        assertEquals(listOf("e2"), eventIds(again))
    }

    @Test fun eventsSurviveARestartOfTheApp() {
        link.client.emit("sense.battery", body(7), id = "e1")
        val store = link.store
        TestLink(FakeKernel(), store).use { restarted ->
            val conn = restarted.connect()
            assertEquals("e1", conn.awaitFrame("event").getString("id"))
        }
    }

    @Test fun nothingIsResentWhileTheDeviceChannelIsRefused() {
        link.client.emit("sense.battery", body(1), id = "e1")
        val conn = link.connect(device = false)
        link.client.emit("sense.battery", body(2), id = "e2")
        conn.send(JSONObject().put("t", "ping").put("at", 1))
        conn.awaitFrame("pong")
        Thread.sleep(100)
        assertTrue(conn.framesOf("event").isEmpty())
        assertEquals(listOf("e1", "e2"), link.outbox.pending().map { it.id })
    }

    @Test fun theSameIdQueuedTwiceIsOneEventAndSentOnce() {
        val conn = link.connect()
        link.client.emit("sense.battery", body(1), id = "e1")
        link.client.emit("sense.battery", body(9), id = "e1")
        conn.send(JSONObject().put("t", "ping").put("at", 1))
        awaitTrue("sent") { eventIds(conn).isNotEmpty() }
        conn.awaitFrame("pong")
        assertEquals(listOf("e1"), eventIds(conn))
        assertEquals(1, link.outbox.pending().size)
        assertEquals(1, link.outbox.pending().single().body.getInt("level"))
    }

    @Test fun anEventThatCanNeverBeSentIsDroppedSoItDoesNotBlockTheQueue() {
        val conn = link.connect()
        link.client.emit("not-a-word", body(1), id = "bad")
        link.client.emit("sense.battery", body(2), id = "good")
        assertEquals("good", conn.awaitFrame("event").getString("id"))
        awaitTrue("bad one dropped") { link.outbox.pending().map { it.id } == listOf("good") }
    }

    @Test fun aNonDurableEventIsDroppedWhenTheDeviceChannelIsNotOpen() {
        assertFalse(link.client.emit("sense.notification", body(1), id = "n1", durable = false))
        assertTrue(link.outbox.pending().isEmpty())
        val conn = link.connect()
        Thread.sleep(100)
        assertTrue(conn.framesOf("event").isEmpty())
    }

    @Test fun aNonDurableEventIsSentWithoutBeingStoredWhenTheChannelIsOpen() {
        val conn = link.connect()
        assertTrue(link.client.emit("sense.notification", body(1), id = "n1", durable = false))
        assertEquals("n1", conn.awaitFrame("event").getString("id"))
        assertTrue(link.store.log.isEmpty())
        assertTrue(link.outbox.pending().isEmpty())
    }

    @Test fun theQueueIsBoundedAndDropsTheOldest() {
        val store = FakeEventStore()
        val outbox = EventOutbox(store, limit = 3)
        for (i in 1..5) outbox.add(QueuedEvent("e$i", "sense.battery", body(i), i.toLong()))
        assertEquals(listOf("e3", "e4", "e5"), outbox.pending().map { it.id })
    }
}
