package ai.ash.caps.screen

import ai.ash.screen.island.NativeIsland
import android.content.Context
import android.provider.Settings
import org.json.JSONObject

/**
 * The screen abilities as the rest of Ash sees them: whether the accessibility service is working, the foreground
 * app and the screen's change counter, and the two ways the task island makes room for a call
 * ([ai.ash.caps.Overlay]). The tools themselves are the [ScreenCapabilities] in the capability registry.
 */
object Screen {
    /** The accessibility service is on: Ash can see and operate the screen. */
    fun accessibility() = A11yService.instance != null

    /** The accessibility switch is on in system settings (whether or not the service is running). */
    fun switchedOn(ctx: Context): Boolean = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
        .orEmpty().split(':').any { it.startsWith("${ctx.packageName}/") }

    /** {foreground_package, epoch}; [settle] first waits for the screen to settle. */
    fun screenState(settle: Boolean): JSONObject {
        val service = A11yService.instance
        if (settle) service?.awaitIdle(250, 1000)
        return JSONObject().put("foreground_package", service?.foregroundPackage().orEmpty()).put("epoch", A11yService.screenEpoch.get())
    }

    /** Ash's own input to other apps (opening an app, a key) passes under the island; refused while the owner types. */
    fun <T> withTouchPassthrough(action: () -> T): T = NativeIsland.withTouchPassthrough(action)

    /** The island stays out of a capture of the main screen. */
    fun <T> withoutOverlay(action: () -> T): T = NativeIsland.withoutOverlay(action)
}
