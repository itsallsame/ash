package ai.ash.ui

import ai.ash.host.TaskFrame
import ai.ash.host.TaskCard
import org.junit.Assert.*
import org.junit.Test

class IslandPresentationTest {
    private val frame = TaskFrame("s", 1, "t_a", 1000, "done", "本轮回复", emptyList(), false,
        outcome = "completed", reply = "你希望选哪个？\n\nA 还是 B？")
    private val card = TaskCard("ask", "pending", "service:gate", "t_a", "approval", "提交", "正文", "x".repeat(3000),
        listOf("once" to "允许这一次", "deny" to "不允许"), 10000, false, "waiting")
    @Test fun finishedTurnIsNotClassifiedAsSuccessfulDelivery() {
        val value = IslandPresentation.project(frame, 5, false, true, false, null, emptyMap(), 2000)
        assertEquals("reply", value.getString("kind")); assertEquals(frame.reply, value.getString("reply"))
        assertTrue(value.getBoolean("mayClose"))
    }
    @Test fun closeCannotDismissPendingApprovalOrCancelAnything() {
        val value = IslandPresentation.project(frame.copy(cards = listOf(card)), 5, false, true, false, null, emptyMap(), 2000)
        assertFalse(value.getBoolean("mayClose"))
        val actual = value.getJSONArray("cards").getJSONObject(0)
        assertEquals(card.original, actual.getString("original")); assertEquals("once", actual.getJSONArray("options").getJSONObject(0).getString("id"))
        assertEquals("pending", card.pendingId)
    }
    @Test fun failedTurnStaysAvailableAsCompactRatherThanBeingDismissed() {
        val value = IslandPresentation.project(frame.copy(outcome = "error"), 5, false, true, false, null, emptyMap(), 2000)
        assertEquals("incomplete", value.getString("kind")); assertFalse(value.getBoolean("mayClose"))
    }
    @Test fun staleAndExpiryDisableConfirmationWithoutChangingItsIdentity() {
        val value = IslandPresentation.project(frame.copy(cards = listOf(card)), 5, true, true, false, null, emptyMap(), 10001)
        assertEquals("stale", value.getString("kind")); assertFalse(value.getBoolean("interactive")); assertFalse(value.getBoolean("mayClose"))
        assertEquals("expired", value.getJSONArray("cards").getJSONObject(0).getString("state"))
    }
    @Test fun currentExecutionDoesNotUseActionHistoryOrExposeSearchDetails() {
        val value = IslandPresentation.project(frame.copy(state = "working", outcome = "", text = "在看网页 · PRIVATE QUERY", steps = listOf("old")),
            5, false, true, true, null, emptyMap(), 2000)
        assertEquals("working", value.getString("kind")); assertEquals("在看网页", value.getString("activity"))
        assertFalse(value.has("steps")); assertFalse(value.getBoolean("mayClose"))
    }
    @Test fun theComposerIsOfferedOnlyWhenTheFrameNamesAnAgent() {
        assertFalse(IslandPresentation.project(frame, 5, false, true, false, null, emptyMap(), 2000).getBoolean("canSend"))
        assertTrue(IslandPresentation.project(frame.copy(agent = "agent:writer"), 5, false, true, false, null, emptyMap(), 2000).getBoolean("canSend"))
        assertFalse(IslandPresentation.resident(false).getBoolean("canSend"))
    }
    @Test fun aTaskFrameTakesItsAgentFromTheFrameAndNeverGuessesOne() {
        fun raw() = org.json.JSONObject().put("session", "s").put("revision", 1).put("turn", org.json.JSONObject.NULL).put("started_at", 0).put("state", "idle")
            .put("text", "").put("steps", org.json.JSONArray()).put("can_stop", false)
        assertEquals("", TaskFrame.parse(raw()).agent)
        assertEquals("agent:writer", TaskFrame.parse(raw().put("agent", "agent:writer")).agent)
        assertEquals("", TaskFrame.parse(raw().put("agent", "somebody")).agent)
    }
    @Test fun residentEntryCarriesNoTaskContent() {
        val value = IslandPresentation.resident(true)
        assertEquals("resident", value.getString("kind"))
        assertEquals("", value.getString("turn")); assertEquals("", value.getString("reply")); assertEquals("", value.getString("activity"))
        assertEquals(0, value.getJSONArray("cards").length()); assertFalse(value.getBoolean("canStop"))
    }
}
