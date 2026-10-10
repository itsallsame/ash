package ai.ash.human

import ai.ash.link.LinkClient
import org.json.JSONObject

/**
 * Tells the kernel where the owner is (SPEC-03 §5.3): `presence {visible}` when the chat page comes to the front or goes
 * away, and once after every (re)connect, since the kernel knows nothing of a new connection. What the owner is typing, and to
 * which agent, is sent by the chat page itself as `presence {typing, agent}`, through [ChatBridge].
 */
class Presence(private val client: LinkClient, private val visible: () -> Boolean) {
    /** Says whether the chat page is in front now (call it when that changes, and when the human channel opens). */
    fun tell() { client.presence(JSONObject().put("visible", visible())) }
}
