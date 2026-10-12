package ai.ash.caps.system

/**
 * The pure rules for putting an activity on the real screen from the hand app's process (no Android calls here, so
 * they can be tested). Android 10+ drops such a start silently unless an exemption holds, so the order is:
 *  1. the app is in front: start it directly;
 *  2. the app is in the background but exempt (accessibility service running, or, before Android 15, the overlay
 *     permission): start it directly;
 *  3. otherwise fail and say what the owner can turn on.
 * Starting without an exemption is not this app's to do: the kernel host does it (`apps.open` on `service:host`).
 */
object LaunchRoute {
    enum class Way { FOREGROUND, EXEMPT, BLOCKED }

    /** An exemption that lets a background app start an activity itself. */
    fun exempt(sdk: Int, accessibility: Boolean, overlay: Boolean): Boolean = accessibility || (sdk < 35 && overlay)

    /** Whether the app can start an activity on its own. */
    fun direct(sdk: Int, foreground: Boolean, accessibility: Boolean, overlay: Boolean): Boolean =
        sdk < 29 || foreground || exempt(sdk, accessibility, overlay)

    fun choose(sdk: Int, foreground: Boolean, accessibility: Boolean, overlay: Boolean): Way = when {
        sdk < 29 || foreground -> Way.FOREGROUND
        exempt(sdk, accessibility, overlay) -> Way.EXEMPT
        else -> Way.BLOCKED
    }

    /** What the owner can turn on so that the phone can open screens while Ash is in the background, for the recovery hint. */
    const val HINT = "Ask the owner to enable Ash's accessibility service or the overlay permission (display over other apps) " +
        "for Ash, or to bring Ash to the front. Then call again."

    /** True when [front] is the package asked for, false when it is another, null when there is nothing to compare. */
    fun confirmed(expected: String?, front: String?): Boolean? =
        if (expected.isNullOrEmpty() || front.isNullOrEmpty()) null else expected == front
}
