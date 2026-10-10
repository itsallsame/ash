package ai.ash

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Every component the manifest names is a class of the app (a moved or deleted screen would otherwise only fail on the phone). */
class ManifestClassesTest {
    private val manifest = File("src/main/AndroidManifest.xml").readText()
    private val sources = File("src/main/java").walk().filter { it.extension == "kt" }.map { it.path.removePrefix("src/main/java/").removeSuffix(".kt") }.toSet()

    private val names = Regex("""<(?:activity|service|receiver|provider|activity-alias)\s[^>]*?android:name="(\.[\w.]+)"""", RegexOption.DOT_MATCHES_ALL)
        .findAll(manifest).map { it.groupValues[1] }.toList()

    @Test fun everyNamedComponentHasASource() {
        assertTrue(names.isNotEmpty())
        // A class may share a file with others (a receiver next to the object it serves): the file is found by the package, the name by its text.
        val missing = names.filter { n ->
            val path = "ai/ash" + n.replace('.', '/')
            val simple = n.substringAfterLast('.')
            path !in sources && sources.none { it.startsWith(path.substringBeforeLast('/') + "/") && File("src/main/java/$it.kt").readText().contains("class $simple") }
        }
        // The aliases name a class of their own app too; the Shizuku provider and the alias are the only ones that are not.
        assertEquals(emptyList<String>(), missing.filter { it != ".ViewPermissionUsageActivity" })
    }
}
