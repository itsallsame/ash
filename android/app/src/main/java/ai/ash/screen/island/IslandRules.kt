package ai.ash.screen.island

/**
 * When the island opens by itself. It opens only for what needs the owner (a question or an approval waiting on a card,
 * or a step only they can take in Ash); a turn's reply or end only marks the pill, and the mark settles back to the
 * plain pill after a while if the owner never looked.
 */
object IslandRules {
    /** How long a finished turn's mark stays on the pill before it settles. */
    const val SETTLE_MS = 30_000L

    /** [kind] is the frame's kind; [waitingOnOwner] is a card waiting for an answer that has not been given yet. */
    fun opensCard(kind: String, waitingOnOwner: Boolean): Boolean = waitingOnOwner || kind == "in_app"

    /** Frames that report an outcome and need nothing from the owner: their mark settles by itself. */
    fun settles(kind: String): Boolean = kind in SETTLING

    private val SETTLING = setOf("result", "reply", "incomplete", "stopped")

    /** What the agent's own screen work does about the island before it starts. */
    enum class Step { OWNER_TYPING, NOTHING_TO_MOVE, WAIT_FOR_FRAMES }

    /** Only an open input box makes the agent wait on the owner; an island that is not on screen has nothing to move aside. */
    fun stepFor(editing: Boolean, attached: Boolean): Step = when {
        editing -> Step.OWNER_TYPING
        !attached -> Step.NOTHING_TO_MOVE
        else -> Step.WAIT_FOR_FRAMES
    }

    /**
     * Whether the action runs once the wait is over. A main thread that was too slow to confirm the island stepped aside is
     * not the owner typing: the action runs anyway (at worst one tap lands on the island). Only typing refuses it.
     */
    fun mayRunAfterWait(editing: Boolean): Boolean = !editing
}

/** The owner is typing into the island, so the agent must not take input focus. Any other failure is an ordinary state error. */
class OwnerTypingException(message: String) : IllegalStateException(message)
