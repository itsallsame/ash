package ai.ash.host.apps

import ai.ash.apps.AppIds
import org.json.JSONObject

/**
 * What the apps shell may ask of Ash through the bridge: three words of `service:apps` (the list, a page, an icon), and the
 * tools of the one app the page belongs to. [app] is that app (given by the shell when it binds, one binding per open app), or
 * null for the shell's list screen, which has no app. The shell's process reports the id itself and Ash cannot check it (every
 * process of the app has one uid), so this keeps the shell's own mistakes from reaching another app; it is not a boundary
 * against the shell. Everything else is refused, whatever the shell says.
 */
internal object AppsBridgePolicy {
    const val SERVICE = "service:apps"
    const val LIST = "apps.list"
    const val SURFACE = "apps.surface"
    const val ICON = "apps.icon"

    fun allows(app: String?, to: String, word: String, body: JSONObject): Boolean {
        if (to == SERVICE) {
            // A page asks for its own page and icon only; the list screen asks for any icon, never for a page.
            val id = body.opt("id") as? String
            return when (word) {
                LIST -> true
                SURFACE -> app != null && id == app
                ICON -> if (app != null) id == app else AppIds.valid(id)
                else -> false
            }
        }
        return app != null && to == "app:$app" && AppIds.validTool(word)
    }
}
