package ai.ash.host

import ai.ash.host.BackgroundLaunch.Route
import org.junit.Assert.assertEquals
import org.junit.Test

class BackgroundLaunchTest {
    private fun route(sdk: Int = 35, visible: Boolean = false, accessibility: Boolean = false, overlay: Boolean = false) =
        BackgroundLaunch.route(sdk, visible, accessibility, overlay)

    @Test fun withoutAnExemptionTheOwnerIsAskedByANotice() {
        assertEquals(Route.NOTIFY, route())
    }

    @Test fun eachExemptionLetsTheStartThrough() {
        assertEquals(Route.DIRECT, route(visible = true))
        assertEquals(Route.DIRECT, route(accessibility = true))
        assertEquals(Route.DIRECT, route(overlay = true))
    }

    @Test fun beforeAndroid10NothingRestrictsIt() {
        assertEquals(Route.DIRECT, route(sdk = 28))
        assertEquals(Route.NOTIFY, route(sdk = 29))
    }
}
