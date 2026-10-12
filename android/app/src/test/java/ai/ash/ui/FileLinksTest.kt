package ai.ash.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FileLinksTest {
    private val base = FileRef("main", "notes/today.md")

    @Test fun plainRefsOnly() {
        assertNotNull(FileLinks.ref("main", "a/b.txt"))
        assertNotNull(FileLinks.ref("body:abc", "/etc/hosts"))
        assertNull(FileLinks.ref("main", ""))
        assertNull(FileLinks.ref("main", "a//b"))
        assertNull(FileLinks.ref("main", "a/../b"))
        assertNull(FileLinks.ref("main", "a/./b"))
        assertNull(FileLinks.ref("main", "a\\b"))
        assertNull(FileLinks.ref("ma in", "a"))
        assertNull(FileLinks.ref(null, "a"))
    }

    @Test fun bodyIds() {
        assertEquals("body:main", FileLinks.bodyOf("main"))
        assertEquals("body:main", FileLinks.bodyOf("body:main"))
        assertEquals("body:abcdefghijklmnopqrstuv", FileLinks.bodyOf("abcdefghijklmnopqrstuv"))
        assertNull(FileLinks.bodyOf("short"))
        assertNull(FileLinks.bodyOf("other"))
    }

    @Test fun linksResolveAgainstTheirFile() {
        assertEquals("notes/b.md", FileLinks.resolve("b.md", base)?.path)
        assertEquals("b.md", FileLinks.resolve("../b.md", base)?.path)
        assertEquals("notes/sub/c.txt", FileLinks.resolve("./sub/c.txt#top", base)?.path)
        assertEquals("/abs/x.md", FileLinks.resolve("/abs/x.md", base)?.path)
        assertEquals("notes/é 1.md", FileLinks.resolve("%C3%A9%201.md", base)?.path)
        assertEquals("main", FileLinks.resolve("b.md", base)?.workspace)
        assertEquals("x.md", FileLinks.resolve("x.md")?.path)
    }

    @Test fun notPathsAreNothingToOpen() {
        for (bad in listOf("https://x.y/z", "javascript:alert(1)", "//host/x", "#top", "../../up.md", "/../x", "a\\b", "a%zz", "a\u0001b", "mailto:a@b.c", "%FF"))
            assertNull(bad, FileLinks.resolve(bad, base))
        assertNull(FileLinks.resolve(null, base))
    }

    @Test fun refNames() {
        assertEquals("c.txt", FileRef("main", "a/b/c.txt").baseName)
        assertEquals("a/b", FileRef("main", "a/b/c.txt").directory)
        assertEquals("", FileRef("main", "c.txt").directory)
        assertEquals("Shown", FileRef("main", "a/c.txt", "Shown").baseName)
        assertEquals("md", FileLinks.extension("x/Y.MD"))
        assertEquals("", FileLinks.extension("noext"))
    }

    @Test fun markdownLinksSkipCode() {
        val links = FileViewer.markdownLinks("see [one](a.md) and [two](b/c.md \"t\")\n```\n[no](x.md)\n```\n[one](later.md)")
        assertEquals(mapOf("one" to "a.md", "two" to "b/c.md"), links)
        assertTrue(FileViewer.markdownLinks("none").isEmpty())
    }
}
