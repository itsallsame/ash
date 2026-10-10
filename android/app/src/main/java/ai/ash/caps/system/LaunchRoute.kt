package ai.ash.caps.system

/** How Shizuku stands for this app right now. */
enum class ShizukuStatus { READY, NEEDS_AUTH, TOO_OLD, NOT_RUNNING, NOT_INSTALLED }

/**
 * The pure rules for putting an activity on the real screen from the hand app's process (no Android calls here, so
 * they can be tested). Android 10+ drops such a start silently unless an exemption holds, so the order is:
 *  1. the app is in front: start it directly;
 *  2. the app is in the background but exempt (accessibility service running, or, before Android 15, the overlay
 *     permission): start it directly, as before;
 *  3. Shizuku is ready: start it through the Shizuku shell (the shell is always allowed);
 *  4. Shizuku runs but Ash is not authorized yet: ask the owner for the authorization, then try 3;
 *  5. otherwise fail and say what the owner can turn on.
 */
object LaunchRoute {
    enum class Way { FOREGROUND, EXEMPT, SHIZUKU, ASK_SHIZUKU, BLOCKED }

    /** An exemption that lets a background app start an activity itself (not counting Shizuku). */
    fun exempt(sdk: Int, accessibility: Boolean, overlay: Boolean): Boolean = accessibility || (sdk < 35 && overlay)

    /** Whether the app can start an activity on its own, without Shizuku. */
    fun direct(sdk: Int, foreground: Boolean, accessibility: Boolean, overlay: Boolean): Boolean =
        sdk < 29 || foreground || exempt(sdk, accessibility, overlay)

    /** [shizuku] is only asked when no direct way exists (reading it can wait for the Shizuku binder). */
    fun choose(sdk: Int, foreground: Boolean, accessibility: Boolean, overlay: Boolean, shizuku: () -> ShizukuStatus): Way = when {
        sdk < 29 || foreground -> Way.FOREGROUND
        exempt(sdk, accessibility, overlay) -> Way.EXEMPT
        else -> when (shizuku()) {
            ShizukuStatus.READY -> Way.SHIZUKU
            ShizukuStatus.NEEDS_AUTH -> Way.ASK_SHIZUKU
            else -> Way.BLOCKED
        }
    }

    /** What the owner can turn on so that the phone can open apps while Ash is in the background, for the recovery hint. */
    fun hint(shizuku: ShizukuStatus, asked: Boolean = false): String {
        val shizukuStep = when (shizuku) {
            ShizukuStatus.READY -> "Shizuku is ready"
            ShizukuStatus.NEEDS_AUTH ->
                if (asked) "authorize Ash in the Shizuku app (Authorized apps -> Ash); the permission dialog got no answer or was refused"
                else "authorize Ash in Shizuku"
            ShizukuStatus.TOO_OLD -> "update Shizuku (v11 or newer is needed)"
            ShizukuStatus.NOT_RUNNING -> "start the Shizuku service (open the Shizuku app)"
            ShizukuStatus.NOT_INSTALLED -> "install Shizuku and start it"
        }
        return "Ask the owner to enable any one of: Ash's accessibility service, the overlay permission (display over other apps) " +
            "for Ash, or Shizuku (to $shizukuStep) in Ash's permission list; or to bring Ash to the front. Then call again."
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

    /** The shell command whose output [parseFront] reads. */
    const val FRONT_COMMAND =
        "dumpsys activity activities | grep -E 'ResumedActivity' | head -6; dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' | head -4"
}
