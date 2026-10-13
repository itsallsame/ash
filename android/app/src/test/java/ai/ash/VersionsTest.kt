package ai.ash

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The two packages (the app and the kernel) are released together: one version name, and each build handed out has a versionCode no earlier one had. */
class VersionsTest {
    private fun gradle(module: String) = listOf("$module/build.gradle.kts", "../$module/build.gradle.kts").map(::File).first { it.isFile }.readText()
    private fun name(text: String) = Regex("versionName\\s*=\\s*\"([^\"]+)\"").find(text)!!.groupValues[1]
    private fun code(text: String) = Regex("versionCode\\s*=\\s*(\\d+)").find(text)!!.groupValues[1].toInt()

    @Test fun theAppAndTheKernelShareAVersionName() {
        assertEquals(name(gradle("app")), name(gradle("kernel")))
    }

    /** Raise these with every build that leaves the machine (see CONTRIBUTING.md): the floors below are the last release's. */
    @Test fun versionCodesOnlyGoUp() {
        assertTrue("app versionCode must be above the last build handed out (0.4.11, 23)", code(gradle("app")) >= 24)
        assertTrue("kernel versionCode must be above the last build handed out (0.4.11, 16)", code(gradle("kernel")) >= 17)
    }
}
