package ai.ash.caps.config

import ai.ash.caps.config.BatteryExemptionRoute.Page
import ai.ash.caps.config.BatteryExemptionRoute.Route
import ai.ash.caps.config.BatteryExemptionRoute.choose
import org.junit.Assert.assertEquals
import org.junit.Test

class BatteryExemptionRouteTest {
    private val settings = "com.android.settings"
    private val manager = "com.miui.securitycenter"
    private val power = "com.miui.powerkeeper"

    @Test fun oneHandlerOpensTheQuestionAsItIs() {
        assertEquals(Route(Page.REQUEST), choose(listOf(settings), listOf(settings)))
        assertEquals(Route(Page.REQUEST), choose(listOf(manager, manager), emptyList()))
    }

    @Test fun twoHandlersPreferTheSystemSettingsAndPinTheIntentToIt() {
        assertEquals(Route(Page.REQUEST, settings), choose(listOf(manager, settings, power), listOf(settings)))
    }

    @Test fun twoHandlersWithoutSettingsFallToTheListThenToTheAppInfoPage() {
        assertEquals(Route(Page.LIST), choose(listOf(manager, power), listOf(power)))
        assertEquals(Route(Page.LIST, settings), choose(listOf(manager, power), listOf(power, settings)))
        assertEquals(Route(Page.DETAILS), choose(listOf(manager, power), listOf(manager, power)))
    }

    @Test fun noHandlerAtAllStillEndsOnAPage() {
        assertEquals(Route(Page.LIST), choose(emptyList(), listOf(settings)))
        assertEquals(Route(Page.DETAILS), choose(emptyList(), emptyList()))
    }
}
