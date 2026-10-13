package ai.ash.host

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PresentRouteTest {
    @Test fun questionOptionsAndCustomAnswersKeepTheirOriginalRoute() {
        val option = PresentRoutes.answer("m_question", "service:gate", setOf("home", "work"), "work", null, true, 200, 100)
        assertEquals("work", option.choice)
        assertEquals("m_question", option.replyTo)
        val custom = PresentRoutes.answer("m_question", "service:gate", setOf("home"), "custom", "  公司  ", true, 200, 100)
        assertEquals("公司", custom.text)
        assertEquals("service:gate", custom.to)
        assertThrows(IllegalArgumentException::class.java) { PresentRoutes.answer("m_question", "service:gate", setOf("home"), "custom", "公司", false, 200, 100) }
        assertThrows(IllegalArgumentException::class.java) { PresentRoutes.answer("m_question", "service:gate", setOf("home"), "unoffered", null, true, 200, 100) }
        assertThrows(IllegalArgumentException::class.java) { PresentRoutes.answer("m_question", "service:gate", setOf("home"), "home", null, true, 100, 100) }
    }

    @Test fun aGateCardWithItsOwnOptionsIsAnsweredWithThemOnEverySurface() {
        val lease = PresentRoutes.answer("m_lease", "service:gate", setOf("task", "m15", "h1", "deny"), "m15", null, false, 200, 100)
        assertEquals("m15", lease.choice)
        val message = PresentRoutes.answerMessage(lease, PresentRoutes.answerClientId("m_lease"))
        assertEquals("answer:m_lease", message.getString("client_id"))
        assertEquals("m15", message.getJSONObject("body").getJSONObject("result").getJSONObject("data").getString("choice"))
    }

    @Test fun notificationApprovalNeedsDenyButAllowsAnOfferedSubset() {
        assertEquals(true, PresentRoutes.notificationOptionsValid(listOf("once", "deny")))
        assertEquals(true, PresentRoutes.notificationOptionsValid(listOf("once", "always", "deny")))
        assertEquals(false, PresentRoutes.notificationOptionsValid(listOf("once")))
        assertEquals(false, PresentRoutes.notificationOptionsValid(listOf("once", "deny", "deny")))
    }

    @Test fun eachOfferedApprovalUsesTheStoredAskSender() {
        for (choice in listOf("once", "always", "deny")) {
            val route = PresentRoutes.answer("m_request", "service:gate", setOf("once", "always", "deny"), choice, null, false, 200, 100)
            assertEquals("service:gate", route.to)
            assertEquals("response", route.kind)
            assertEquals("ask", route.word)
            assertEquals("m_request", route.replyTo)
            assertEquals(choice, route.choice)
        }
    }

    @Test fun arbitraryCallbackAndUnofferedOrExpiredChoiceAreRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            PresentRoutes.answer("m_request", "https://example.invalid", setOf("once"), "once", null, false, 200, 100)
        }
        assertThrows(IllegalArgumentException::class.java) {
            PresentRoutes.answer("m_request", "service:gate", setOf("once", "deny"), "always", null, false, 200, 100)
        }
        assertThrows(IllegalArgumentException::class.java) {
            PresentRoutes.answer("m_request", "service:gate", setOf("once"), "once", null, false, 100, 100)
        }
    }

    @Test fun directNotificationReplyGoesToTheAgentThePresentationNamed() {
        val route = PresentRoutes.reply("agent:writer", "  Hello  ")
        assertEquals("agent:writer", route.to)
        assertEquals("request", route.kind)
        assertEquals("say", route.word)
        assertEquals("Hello", route.text)
        assertThrows(IllegalArgumentException::class.java) { PresentRoutes.reply("agent:writer", "   ") }
        assertThrows(IllegalArgumentException::class.java) { PresentRoutes.reply("not a member", "Hello") }
        assertThrows(IllegalArgumentException::class.java) { PresentRoutes.reply("", "Hello") }
    }
}
