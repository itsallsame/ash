package ai.ash.host

/** Pure route construction; notification text and PendingIntent extras never choose the recipient. */
data class PresentRoute(val to: String, val kind: String, val word: String, val replyTo: String? = null,
    val choice: String? = null, val text: String? = null)

object PresentRoutes {
    val member = Regex("^(person|screen|agent|device|service|worker):[A-Za-z0-9_.-]+$")

    fun notificationOptionsValid(ids: List<String>): Boolean = ids.isNotEmpty() && "deny" in ids &&
        ids.size == ids.toSet().size && ids.all { it in setOf("once", "always", "deny") }

    /**
     * The owner's answer to an ask the hub put to them, the same from every surface (chat card, island, notification): the ask's id,
     * its sender, one of its own options, or a typed answer ([CUSTOM]) when it takes one. Only the shape is checked here; the hub
     * judges the answer against the ask it holds.
     */
    fun answer(replyTo: String, replyTarget: String, offered: Set<String>, choice: String?, text: String?,
        allowCustom: Boolean, expiresAt: Long, now: Long): PresentRoute {
        require(replyTo.isNotBlank() && member.matches(replyTarget) && expiresAt > now) { "answer route expired or missing" }
        if (choice == CUSTOM) {
            require(allowCustom && !text.isNullOrBlank() && text.length <= 4000) { "custom answer not allowed" }
            return PresentRoute(replyTarget, "response", "ask", replyTo = replyTo, choice = CUSTOM, text = text.trim())
        }
        require(choice != null && choice in offered) { "choice was not offered" }
        return PresentRoute(replyTarget, "response", "ask", replyTo = replyTo, choice = choice)
    }

    /** The choice of a typed answer. */
    const val CUSTOM = "custom"

    /** What goes to the hub for an answer [route]: the response to the ask; [clientId] keeps a retry, or a second surface, from answering twice. */
    fun answerMessage(route: PresentRoute, clientId: String): org.json.JSONObject = org.json.JSONObject().put("to", route.to).put("kind", "response").put("word", "ask")
        .put("reply_to", route.replyTo).put("client_id", clientId)
        .put("body", org.json.JSONObject().put("ok", true).put("result", org.json.JSONObject().put("data",
            org.json.JSONObject().put("choice", route.choice).apply { if (route.text != null) put("text", route.text) })))

    /** The client id of the owner's answer to ask [askId], whichever surface it comes from. */
    fun answerClientId(askId: String) = "answer:$askId"

    /** A reply typed into a notification goes to [target], the agent that spoke (given by the presentation). */
    fun reply(target: String, text: String): PresentRoute {
        require(member.matches(target)) { "reply target missing" }
        val trimmed = text.trim()
        require(trimmed.isNotEmpty()) { "reply is empty" }
        return PresentRoute(target, "request", "say", text = trimmed)
    }
}
