package ai.ash

/** When the app's pages may be inspected from a computer (chrome://inspect): in a debug build, or in the isolated probe build; never in a release. */
object WebDebugging {
    fun enabled(debugBuild: Boolean, isolatedProbe: Boolean): Boolean = debugBuild || isolatedProbe
}
