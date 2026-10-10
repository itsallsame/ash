package ai.ash.caps.config

/**
 * Which page opens for the battery exemption. The system's one-tap question (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) is
 * answered by two system apps on MIUI, so Android puts up its "choose an app" box. Nothing here touches Android: given
 * who answers each page, it picks one that opens without a question.
 */
object BatteryExemptionRoute {
    const val SETTINGS = "com.android.settings"

    enum class Page {
        /** The one-tap question for Ash. */
        REQUEST,
        /** The list of apps and their exemption. */
        LIST,
        /** Ash's own app-info page, which every phone has. */
        DETAILS,
    }

    /** [page] opens in [pkg] when it is set (the intent is pinned to that app, so no chooser), otherwise as it is. */
    data class Route(val page: Page, val pkg: String? = null)

    /** [requestHandlers] and [listHandlers]: the package names whose activities answer each page. */
    fun choose(requestHandlers: List<String>, listHandlers: List<String>): Route {
        pick(Page.REQUEST, requestHandlers)?.let { return it }
        pick(Page.LIST, listHandlers)?.let { return it }
        return Route(Page.DETAILS)
    }

    private fun pick(page: Page, handlers: List<String>): Route? {
        val packages = handlers.distinct()
        return when {
            packages.isEmpty() -> null
            packages.size == 1 -> Route(page)
            SETTINGS in packages -> Route(page, SETTINGS)
            else -> null // several, none of them the system's settings: the next page down is surer than a box
        }
    }
}
