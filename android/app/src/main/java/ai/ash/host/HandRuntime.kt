package ai.ash.host

import ai.ash.BuildConfig
import ai.ash.caps.senses.CalendarSense
import ai.ash.caps.senses.DeviceSense
import android.content.Context

/**
 * What runs for as long as the hand app's process lives. The app has no foreground service of its own any more: the
 * kernel binds [ai.ash.link.HandService], which keeps this process at the kernel's priority, and the process starts
 * this from [ai.ash.AshApp]. (It is what the old core service started next to the core: the owner-facing
 * presentation state and the app's own senses.)
 */
object HandRuntime {
    private var calendar: CalendarSense? = null
    private var device: DeviceSense? = null

    @Synchronized fun start(ctx: Context) {
        if (calendar != null) return
        val app = ctx.applicationContext
        Notifications.clearLegacy(app)
        // The island layer has its context before anything is presented (a `present` handler starts this first).
        ai.ash.host.screen.ScreenBridge.attach(app)
        Present.restore(app)
        TaskStatus.start(app)
        calendar = CalendarSense(app, BuildConfig.SENSE_RESCAN_MS).also { it.start() }
        device = DeviceSense(app).also { it.start() }
    }

    /** A calendar reminder alarm went off, or the calendar may have changed. */
    @Synchronized fun calendarRefresh() { calendar?.refresh() }

    /** The chat page came to the front. */
    @Synchronized fun appOpened(ctx: Context) {
        Present.clearChat(ctx)
        device?.appOpen()
        calendar?.refresh()
    }

    /** The chat page went away. */
    @Synchronized fun appLeft() { device?.appLeft() }
}
