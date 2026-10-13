package ai.ash

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class WebDebuggingTest {
    @Test fun aDebugBuildAndTheProbeBuildMayBeInspectedAReleaseNever() {
        assertTrue(WebDebugging.enabled(debugBuild = true, isolatedProbe = false))
        assertTrue(WebDebugging.enabled(debugBuild = false, isolatedProbe = true))
        assertTrue(WebDebugging.enabled(debugBuild = true, isolatedProbe = true))
        assertFalse("a release build", WebDebugging.enabled(debugBuild = false, isolatedProbe = false))
    }

    /** The one place that turns it on asks [WebDebugging]; nothing switches it on by itself (a literal true, or only the probe flag). */
    @Test fun everyCallThatTurnsRemoteDebuggingOnGoesThroughTheRule() {
        val root = listOf("src/main/java", "app/src/main/java").map(::File).first { it.isDirectory }
        val calls = root.walkTopDown().filter { it.extension == "kt" || it.extension == "java" }
            .flatMap { f -> f.readLines().filter { "setWebContentsDebuggingEnabled(" in it }.map { f.name to it.trim() } }.toList()
        assertEquals("one process-wide switch: $calls", 1, calls.size)
        assertTrue(calls.toString(), calls.single().second.contains("WebDebugging.enabled(BuildConfig.DEBUG, BuildConfig.ISOLATED_PROBE)"))
    }

    /** The release build type does not turn the probe flag on, and the debug flag is the build's own. */
    @Test fun theReleaseBuildTypeIsNotDebuggableAndHasNoProbe() {
        val gradle = listOf("build.gradle.kts", "app/build.gradle.kts").map(::File).first { it.isFile }.readText()
        val release = gradle.substringAfter("buildTypes {").substringAfter("\n        release {").substringBefore("\n        }")
        assertTrue("found the release build type", release.isNotBlank() && release.length < 600)
        assertFalse("release must not be debuggable", Regex("isDebuggable\\s*=\\s*true").containsMatchIn(release))
        assertFalse("release must not enable the probe", release.contains("ISOLATED_PROBE\", \"true\""))
    }
}
