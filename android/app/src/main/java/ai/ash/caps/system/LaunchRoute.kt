package ai.ash.caps.system

/** How the phone's debug identity (「后台也能动手」, a host service the owner connects) stands for this app right now. */
enum class HostShellStatus { READY, ABSENT, NOT_PAIRED }

/**
 * The pure rules for putting an activity on the real screen from the hand app's process (no Android calls here, so
 * they can be tested). Android 10+ drops such a start silently unless an exemption holds, so the order is:
 *  1. the app is in front: start it directly;
 *  2. the app is in the background but exempt (accessibility service running, or, before Android 15, the overlay
 *     permission): start it directly, as before;
 *  3. the debug identity is connected: start it through it (`am start` as the shell user is always allowed);
 *  4. otherwise fail and say what the owner can turn on.
 */
object LaunchRoute {
    enum class Way { FOREGROUND, EXEMPT, HOST_SHELL, BLOCKED }

    /** An exemption that lets a background app start an activity itself (not counting the debug identity). */
    fun exempt(sdk: Int, accessibility: Boolean, overlay: Boolean): Boolean = accessibility || (sdk < 35 && overlay)

    /** Whether the app can start an activity on its own, without the debug identity. */
    fun direct(sdk: Int, foreground: Boolean, accessibility: Boolean, overlay: Boolean): Boolean =
        sdk < 29 || foreground || exempt(sdk, accessibility, overlay)

    fun choose(sdk: Int, foreground: Boolean, accessibility: Boolean, overlay: Boolean, hostShell: HostShellStatus): Way = when {
        sdk < 29 || foreground -> Way.FOREGROUND
        exempt(sdk, accessibility, overlay) -> Way.EXEMPT
        hostShell == HostShellStatus.READY -> Way.HOST_SHELL
        else -> Way.BLOCKED
    }

    /** What the owner can turn on so that the phone can open apps while Ash is in the background, for the recovery hint. */
    fun hint(hostShell: HostShellStatus): String {
        val step = when (hostShell) {
            HostShellStatus.READY -> "「后台也能动手」 is connected"
            HostShellStatus.ABSENT -> "connect 「后台也能动手」 again (the owner turns Wireless debugging on when Ash asks, then off)"
            HostShellStatus.NOT_PAIRED -> "pair 「后台也能动手」 once in Ash's checkup"
        }
        return "Ask the owner to enable any one of: Ash's accessibility service, the overlay permission (display over other apps) " +
            "for Ash, or the phone's debug identity ($step); or to bring Ash to the front. Then call again."
    }

    /**
     * The package in front, from `dumpsys activity` / `dumpsys window` text: the resumed activity first, the focused
     * window or app after it. Lines look like `topResumedActivity=ActivityRecord{1a2 u0 com.x.y/.Main t5}` and
     * `mCurrentFocus=Window{3b4 u0 com.x.y/com.x.y.Main}`.
     */
    fun parseFront(dump: String): String? {
        val component = Regex("""\bu\d+ ([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/""")
        val lines = dump.lineSequence().toList()
        for (key in listOf("topResumedActivity", "mResumedActivity", "ResumedActivity", "mCurrentFocus", "mFocusedApp")) {
            for (line in lines) {
                if (!line.contains(key)) continue
                component.find(line)?.let { return it.groupValues[1] }
            }
        }
        return null
    }

    /** True when [front] is the package asked for, false when it is another, null when there is nothing to compare. */
    fun confirmed(expected: String?, front: String?): Boolean? =
        if (expected.isNullOrEmpty() || front.isNullOrEmpty()) null else expected == front
}
