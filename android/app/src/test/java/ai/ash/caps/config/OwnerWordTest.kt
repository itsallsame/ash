package ai.ash.caps.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 「你说已开」: the owner's word is kept by item, taken in until the system shows the item on, and then dropped. */
class OwnerWordTest {
    private class Memory : OwnerWord.Store {
        val marks = mutableSetOf<String>()
        override fun has(key: String) = key in marks
        override fun put(key: String) { marks += key }
        override fun remove(key: String) { marks -= key }
    }

    private val memory = Memory()
    private val word = OwnerWord(memory)

    @Test fun theWordIsKeptPerItemAndCanBeTakenBack() {
        assertFalse(word.said("notifications"))
        word.say("notifications")
        assertTrue(word.said("notifications"))
        assertFalse("another item is untouched", word.said("exact_alarm"))
        word.clear("notifications")
        assertFalse(word.said("notifications"))
    }

    @Test fun anItemIsMarkedUnderTheKeyOfItsPermissionSoTheGuideAndTheCheckupMeet() {
        assertEquals("battery", OwnerWord.keyOf("battery_optimization"))
        assertEquals("notification_access", OwnerWord.keyOf("notification_listener"))
        assertEquals("lock", OwnerWord.keyOf("recents_lock"))
        assertEquals("lock", OwnerWord.keyOf("lock"))
        assertEquals("autostart", OwnerWord.keyOf("autostart"))
        assertEquals("exact_alarm", OwnerWord.keyOf("exact_alarm"))
        word.say("recents_lock")
        assertTrue("the checkup's id for it reads the same mark", word.said("lock"))
        assertEquals(setOf("lock"), memory.marks)
    }

    @Test fun anItemThatReadsOffStandsOnTheOwnersWordAndSaysThatTheSystemDisagrees() {
        assertEquals(Standing.OFF, word.settle("overlay", read = false, unreadable = false))
        assertFalse(word.contradicted("overlay", read = false, unreadable = false))
        word.say("overlay")
        assertEquals(Standing.SAID, word.settle("overlay", read = false, unreadable = false))
        assertTrue("it can be read and reads off: the owner is told so", word.contradicted("overlay", read = false, unreadable = false))
        assertTrue("the word stays while the system keeps saying off", word.said("overlay"))
    }

    @Test fun onceTheSystemReadsItOnTheWordIsDropped() {
        word.say("overlay")
        assertEquals(Standing.ON, word.settle("overlay", read = true, unreadable = false))
        assertFalse(word.said("overlay"))
        // and if the owner later turns it off again, it is simply off: the old word does not come back
        assertEquals(Standing.OFF, word.settle("overlay", read = false, unreadable = false))
        assertFalse(word.contradicted("overlay", read = false, unreadable = false))
    }

    @Test fun aSwitchThePhoneKeepsFromAshHasOnlyTheOwnersWordAndItIsNeverDropped() {
        // read = whether it can be set at all (what it needs first is on)
        assertEquals(Standing.OFF, word.settle("autostart", read = true, unreadable = true))
        word.say("autostart")
        assertEquals(Standing.SAID, word.settle("autostart", read = true, unreadable = true))
        assertTrue("it stays: there is nothing else to read it from", word.said("autostart"))
        assertFalse("nothing to contradict it with", word.contradicted("autostart", read = true, unreadable = true))
        assertEquals("not settable yet: the word does not count", Standing.OFF, word.settle("autostart", read = false, unreadable = true))
    }

    @Test fun theRecoveryGrantIsNotSomethingTheOwnerCanSayIsOn() {
        assertFalse("it takes a computer or Shizuku", OwnerWord.mayBeSaid("screen_recovery"))
        assertTrue(OwnerWord.mayBeSaid("accessibility")); assertTrue(OwnerWord.mayBeSaid("notifications"))
    }
}
