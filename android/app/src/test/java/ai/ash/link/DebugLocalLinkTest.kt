package ai.ash.link

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions

class DebugLocalLinkTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun link(enabled: Boolean, root: File = tmp.root, at: Long = 1_700_000_000_000L) =
        DebugLocalLink(enabled, DebugLocalLink.dirIn(root)) { at }

    private fun file(root: File = tmp.root) = File(DebugLocalLink.dirIn(root), DebugLocalLink.FILE_NAME)

    @Test fun aReleaseBuildWritesNothingNotEvenTheDirectory() {
        val l = link(enabled = false)
        assertTrue(l.write(8765, "tok").isSuccess)
        assertFalse(file().exists())
        assertFalse(DebugLocalLink.dirIn(tmp.root).exists())
    }

    @Test fun aDebugBuildWritesPortTokenAndTimeAsMode0600() {
        assertTrue(link(enabled = true).write(8765, "tok-abc").isSuccess)
        val j = JSONObject(file().readText())
        assertEquals(8765, j.getInt("port"))
        assertEquals("tok-abc", j.getString("token"))
        assertEquals(1_700_000_000_000L, j.getLong("at"))
        assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(file().toPath())))
        assertEquals("rwx------", PosixFilePermissions.toString(Files.getPosixFilePermissions(DebugLocalLink.dirIn(tmp.root).toPath())))
    }

    @Test fun aNewTokenReplacesTheOldOneAndLeavesNoTemporaryFile() {
        val l = link(enabled = true)
        l.write(8765, "first")
        l.write(9000, "second")
        val j = JSONObject(file().readText())
        assertEquals(9000, j.getInt("port"))
        assertEquals("second", j.getString("token"))
        assertEquals(listOf(DebugLocalLink.FILE_NAME), DebugLocalLink.dirIn(tmp.root).list()!!.toList())
        assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(file().toPath())))
    }

    @Test fun clearDeletesTheFileAndIsHarmlessWhenThereIsNone() {
        val l = link(enabled = true)
        l.clear()
        l.write(8765, "tok")
        assertTrue(file().exists())
        l.clear()
        assertFalse(file().exists())
        l.clear()
    }

    @Test fun clearOfADisabledLinkTouchesNothing() {
        link(enabled = true).write(8765, "tok")
        link(enabled = false).clear()
        assertTrue(file().exists())
    }

    @Test fun onlyADebugBuildOfADebuggablePackageIsEnabled() {
        val debuggable = android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE
        assertTrue(DebugLocalLink.enabledFor(true, debuggable))
        assertFalse(DebugLocalLink.enabledFor(true, 0))
        assertFalse(DebugLocalLink.enabledFor(false, debuggable))
        assertFalse(DebugLocalLink.enabledFor(false, 0))
    }
}
