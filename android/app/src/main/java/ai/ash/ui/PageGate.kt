package ai.ash.ui

/**
 * Tells which loaded document of the WebView is the live chat page. Two events speak of a page: the WebView's
 * `onPageStarted` and the page's own `hello` over `AshNative`. They come from different queues, and the order between them
 * is not promised: on a slow phone `hello` can be handled first. A `hello` taken as "no page yet" and dropped would leave the
 * page waiting for a `ready` that never comes (stuck on 「连接中…」), so a `hello` is accepted either way, and the start event
 * that arrives late for the same document is recognised and does not end it.
 *
 * Plain logic, called from the main thread only; [epoch] may be read from anywhere. 0 means no verified page of the app is loaded.
 */
class PageGate {
    @Volatile var epoch = 0L
        private set
    private var count = 0L
    /** A start event announced a document that has not said `hello` yet. */
    private var startSeen = false
    /** A `hello` came before the start event of its document, which is still to come. */
    private var helloFirst = false
    private var doc: String? = null

    enum class Started {
        /** Not a page of the app: nothing is live. */
        OFF,
        /** A new document: whatever was attached to the old one ends. */
        NEW,
        /** The late start event of a document whose `hello` was already taken: nothing changes. */
        SAME,
    }

    enum class Hello {
        /** The first `hello` of this document: attach it. */
        ATTACH,
        /** As [ATTACH], but an older document was attached and must be detached first (its start event is yet to come). */
        REPLACE,
        /** The same document says it again (it asks until it hears `ready`): answer `ready`, change nothing. */
        AGAIN,
    }

    /** `onPageStarted` for [isApp] (the url is the packaged chat page). */
    fun started(isApp: Boolean): Started {
        if (!isApp) {
            epoch = 0; startSeen = false; helloFirst = false; doc = null
            return Started.OFF
        }
        if (helloFirst) { helloFirst = false; return Started.SAME }
        epoch = ++count; startSeen = true; doc = null
        return Started.NEW
    }

    /** A `hello` of the document called [docId] (from the app's origin, main frame). */
    fun hello(docId: String): Hello {
        if (epoch != 0L && docId == doc) return Hello.AGAIN
        val older = doc != null
        if (startSeen) startSeen = false else { epoch = ++count; helloFirst = true }
        doc = docId
        return if (older && helloFirst) Hello.REPLACE else Hello.ATTACH
    }
}
