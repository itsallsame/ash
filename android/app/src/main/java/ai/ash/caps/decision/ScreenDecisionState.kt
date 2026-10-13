package ai.ash.caps.decision

/** Which turn the phone is in and a state epoch; no model-supplied metadata can claim either. */
class ScreenDecisionState {
    var turn: String = ""
        private set
    var epoch: Long = 0
        private set
    private val applied = LinkedHashSet<String>()

    @Synchronized fun beginTurn(id: String) { if (turn != id) { turn = id; epoch++ } }
    @Synchronized fun screenChanged() { epoch++ }
    @Synchronized fun mayReturn(id: String, owner: String): Boolean = id !in applied && owner.isNotBlank() && owner == turn
    @Synchronized fun applied(id: String) {
        applied.add(id)
        while (applied.size > 256) applied.remove(applied.first())
    }
}
