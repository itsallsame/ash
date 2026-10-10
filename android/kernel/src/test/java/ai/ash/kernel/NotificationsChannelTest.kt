package ai.ash.kernel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationsChannelTest {
    @Test fun theMinimumImportanceChannelIsANewIdAndTheOldOneIsRetired() {
        assertEquals("ash.kernel.status.v2", Notifications.CHANNEL)
        assertTrue("ash.kernel.status" in Notifications.RETIRED_CHANNELS)
        assertFalse(Notifications.CHANNEL in Notifications.RETIRED_CHANNELS)
    }

    @Test fun miuiAppIconExtraKeyIsPinned() {
        assertEquals("miui.appIcon", Notifications.MIUI_APP_ICON)
    }
}
