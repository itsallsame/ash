package ai.ash.kernel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The activity that starts the service from another package must stay behind the signature permission and take no input. */
class StartActivityManifestTest {
    private val manifest = File("src/main/AndroidManifest.xml").readText()
    private val declaration = Regex("""<activity\s[^>]*?android:name="\.StartActivity"[^>]*?/>""", RegexOption.DOT_MATCHES_ALL).find(manifest)?.value

    @Test fun isDeclaredExportedBehindTheKernelSignaturePermission() {
        assertTrue("StartActivity is not declared", declaration != null)
        assertTrue(declaration!!.contains("""android:exported="true""""))
        assertTrue(declaration.contains("""android:permission="ai.ash.permission.KERNEL""""))
        assertTrue(manifest.contains("""<permission android:name="ai.ash.permission.KERNEL" android:protectionLevel="signature" />"""))
    }

    @Test fun hasNoIntentFilterSoOnlyAnExplicitStartReachesIt() {
        assertFalse(declaration!!.contains("intent-filter"))
        assertTrue("self-closing declaration expected", declaration.trimEnd().endsWith("/>"))
    }

    @Test fun readsNothingFromTheIntentThatStartedIt() {
        val source = File("src/main/java/ai/ash/kernel/StartActivity.kt").readText()
        for (read in listOf("intent", "getIntent", "extras", "getStringExtra")) assertFalse(read, Regex("""(?<![\w.])$read\b""").containsMatchIn(source.lines().filterNot { it.trimStart().startsWith("*") || it.trimStart().startsWith("/*") }.joinToString("\n")))
        assertEquals(1, Regex("""KernelService\.start\(this\)""").findAll(source).count())
    }
}
