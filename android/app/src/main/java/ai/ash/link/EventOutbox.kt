package ai.ash.link

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject

/** One event of the device channel, as queued: sent as `{t:"event", ch:"device", id, word, body, at}`. */
class QueuedEvent(val id: String, val word: String, val body: JSONObject, val at: Long)

/** Where the events wait. A phone keeps them in SQLite ([SqliteEventStore]); a test uses a fake. */
interface EventStore {
    /** Stores the event; an id already stored is kept as it is (a retried id is the same event). */
    fun add(event: QueuedEvent)
    fun remove(id: String)
    /** Everything not yet acked, oldest first. */
    fun pending(): List<QueuedEvent>
    fun count(): Int
    /** Forgets the [n] oldest events. */
    fun dropOldest(n: Int)
}

/**
 * Events are queued before they are sent and removed only when the kernel acks them, so what was never acked is sent
 * again, with the same id, after a reconnect (SPEC-03 §4.3). The queue is bounded: past [limit] the oldest are
 * dropped, so a kernel that stays away for days cannot fill the phone.
 */
class EventOutbox(private val store: EventStore, private val limit: Int = DEFAULT_LIMIT) {
    @Synchronized fun add(event: QueuedEvent) {
        store.add(event)
        val over = store.count() - limit
        if (over > 0) store.dropOldest(over)
    }

    @Synchronized fun ack(id: String) = store.remove(id)

    @Synchronized fun pending(): List<QueuedEvent> = store.pending()

    companion object { const val DEFAULT_LIMIT = 20_000 }
}

/** The events table of the app's own database; every statement is one auto-committed write, so an added event is on disk when `add` returns. */
class SqliteEventStore(context: Context) : EventStore {
    private val helper = object : SQLiteOpenHelper(context.applicationContext, "ash-link.db", null, 1) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, word TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL)")
        }
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}
    }

    override fun add(event: QueuedEvent) {
        val values = ContentValues().apply { put("id", event.id); put("word", event.word); put("body", event.body.toString()); put("at", event.at) }
        helper.writableDatabase.insertWithOnConflict("events", null, values, SQLiteDatabase.CONFLICT_IGNORE)
    }

    override fun remove(id: String) { helper.writableDatabase.delete("events", "id = ?", arrayOf(id)) }

    override fun pending(): List<QueuedEvent> {
        val out = ArrayList<QueuedEvent>()
        helper.readableDatabase.rawQuery("SELECT id, word, body, at FROM events ORDER BY seq", null).use { c ->
            while (c.moveToNext()) {
                val body = runCatching { JSONObject(c.getString(2)) }.getOrNull() ?: continue
                out.add(QueuedEvent(c.getString(0), c.getString(1), body, c.getLong(3)))
            }
        }
        return out
    }

    override fun count(): Int = helper.readableDatabase.rawQuery("SELECT COUNT(*) FROM events", null).use { if (it.moveToFirst()) it.getInt(0) else 0 }

    override fun dropOldest(n: Int) {
        helper.writableDatabase.execSQL("DELETE FROM events WHERE seq IN (SELECT seq FROM events ORDER BY seq LIMIT ?)", arrayOf<Any>(n))
    }
}
