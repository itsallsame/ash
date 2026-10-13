package ai.ash.ui

import ai.ash.ui.OnboardingContent.Look
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OnboardingContentTest {
    private val all = OnboardingContent.pages

    private fun words(c: OnboardingContent.PageCopy): List<String> =
        listOfNotNull(c.name, c.say, c.primary, c.preview?.title, c.preview?.whenText, c.preview?.body, c.preview?.caption, c.hand?.path, c.hand?.step1)

    @Test fun eachScreenHasTheTemplatePiecesItNeeds() {
        for ((item, c) in all) {
            when (c.look) {
                Look.ASK -> assertTrue("$item needs an example", c.preview != null && c.hand == null)
                Look.HAND -> assertTrue("$item needs the settings row", c.hand != null && c.preview == null)
            }
            assertTrue("$item: the bold word is paired", c.say.split("**").size % 2 == 1)
            assertTrue("$item: one word carries the sentence", c.say.contains("**"))
        }
    }

    @Test fun theWordsAreTheOwnersNotTheDevelopers() {
        val banned = listOf("内核", "JEV", "DSH", "turn", "gate", "id:", "/data", "/sdcard", "config", "permission", "http")
        for ((item, c) in all) for (w in words(c)) for (b in banned) assertFalse("$item says \"$b\": $w", w.contains(b))
        for (w in listOf(OnboardingContent.Words.WELCOME_TITLE, OnboardingContent.Words.WELCOME_BODY, OnboardingContent.Words.BRAIN_TITLE, OnboardingContent.Words.DONE_TITLE))
            assertFalse(w, w.contains("内核"))
    }

    @Test fun buttonsStartWithAVerbAndAreShort() {
        for ((item, c) in all) {
            assertTrue("$item button: ${c.primary}", c.primary.length in 2..8)
            assertFalse(c.primary, c.primary in setOf("确定", "OK", "提交"))
        }
    }

    @Test fun theHandSettingsPathsReadLikeTheSystemsOwn() {
        for ((item, c) in all.filterValues { it.look == Look.HAND }) {
            val h = c.hand!!
            assertTrue("$item: ${h.path}", h.path.startsWith("系统设置 › "))
            assertTrue("$item: ${h.step1}", h.step1.startsWith("点下面的按钮"))
        }
        assertEquals("系统设置 › 无障碍 › 已下载的应用", all.getValue("accessibility").hand!!.path)
    }

    @Test fun anItemWithoutCopyStillGetsAScreen() {
        val c = OnboardingContent.of("future_thing", "新的一项", "它能做什么")
        assertEquals("新的一项", c.name)
        assertTrue(c.say.contains("**新的一项**"))
        assertEquals("去开启", c.primary)
    }
}
