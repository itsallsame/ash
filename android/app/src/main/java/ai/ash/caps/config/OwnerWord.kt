package ai.ash.caps.config

import android.content.Context

/** How an item stands once the owner's word is taken in: on as the system reads it, on because the owner said so, or off. */
enum class Standing { ON, SAID, OFF }

/**
 * 「你说已开」: the owner's word that a switch is on, kept on this phone by item, for the phone that does not show Ash a switch it
 * has really been given (a maker's own settings, or a system that is slow to report). One store serves the first-launch guide and
 * the checkup, and the owner's word for a [Permission.confirmable] switch (the phone's own, which Ash cannot read at all) is the same mark.
 *
 * What the system still reads wins: when it reads an item on, the word is cleared ([settle]). An item that can be read and reads off
 * stays 「你说已开」 and is told so in so many words ([contradicted]); an item that cannot be read has only the owner's word.
 */
class OwnerWord(private val store: Store) {
    interface Store {
        fun has(key: String): Boolean
        fun put(key: String)
        fun remove(key: String)
    }

    fun said(item: String): Boolean = store.has(keyOf(item))
    fun say(item: String) = store.put(keyOf(item))
    fun clear(item: String) = store.remove(keyOf(item))

    /**
     * Where [item] stands. [read] is what the system says (on or off); for an [unreadable] switch it only says whether the switch can be
     * set at all (what it needs first is on), and the owner's word is the whole answer. A readable item that reads on drops the word.
     */
    fun settle(item: String, read: Boolean, unreadable: Boolean): Standing = when {
        unreadable -> if (read && said(item)) Standing.SAID else Standing.OFF
        read -> { if (said(item)) clear(item); Standing.ON }
        said(item) -> Standing.SAID
        else -> Standing.OFF
    }

    /** The owner said it is on, but the system, which can tell, still shows it off. */
    fun contradicted(item: String, read: Boolean, unreadable: Boolean): Boolean = !unreadable && !read && said(item)

    private class Prefs(private val ctx: Context) : Store {
        private val prefs get() = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        override fun has(key: String) = prefs.getBoolean(PREFIX + key, false)
        override fun put(key: String) { prefs.edit().putBoolean(PREFIX + key, true).apply() }
        override fun remove(key: String) { prefs.edit().remove(PREFIX + key).apply() }
    }

    companion object {
        // the file and the key shape the keep-alive switches' confirmation has always used
        private const val PREFS = "ash.permissions"
        private const val PREFIX = "confirmed:"

        /** Items the owner's word cannot stand for: the debug identity is there only once Ash holds it, so their word for it is not asked. */
        fun mayBeSaid(item: String): Boolean = item != ai.ash.caps.hostshell.HostShell.ITEM

        fun of(ctx: Context): OwnerWord = OwnerWord(Prefs(ctx.applicationContext))

        /** The key of an item's mark: the entry of [Permissions] it is when it has one (so the checkup's and the guide's ids meet), else the item's own id. */
        fun keyOf(item: String): String = ConfigStatus.PERMISSION_KEY[item] ?: item
    }
}
