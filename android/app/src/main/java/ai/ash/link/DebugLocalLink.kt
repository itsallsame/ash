package ai.ash.link

import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions

/**
 * For a debuggable build only: the connection the kernel host last handed over (port, token), kept in the app's own
 * private directory (`files/debug/local-link.json`) so that an adb-driven tool can read it with
 * `adb shell run-as ai.ash.agent cat files/debug/local-link.json`. `run-as` works only for a debuggable package, so a
 * release build offers no way to it; and with [enabled] false (a release build) nothing here writes a byte.
 *
 * The file is mode 0600 and replaced atomically (a temporary file, then a rename); it is rewritten whenever the
 * connection details are handed over again, and deleted by [clear]. Nothing else reads it: the app itself keeps the
 * token in memory only.
 */
class DebugLocalLink(
    private val enabled: Boolean,
    private val dir: File,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val file get() = File(dir, FILE_NAME)

    /** Writes `{port, token, at}`; does nothing when not [enabled]. A failure is returned, never thrown: this must not break an attach. */
    @Synchronized fun write(port: Int, token: String): Result<Unit> {
        if (!enabled) return Result.success(Unit)
        return runCatching {
            Files.createDirectories(dir.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")))
            val tmp = File(dir, "$FILE_NAME.tmp").toPath()
            Files.deleteIfExists(tmp)
            // Created 0600 from the start, so the token is never readable more widely, not even briefly.
            Files.createFile(tmp, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
            Files.write(tmp, JSONObject().put("port", port).put("token", token).put("at", now()).toString().toByteArray(Charsets.UTF_8))
            Files.move(tmp, file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        }
    }

    /** Deletes the file (and a temporary one left by an interrupted write). Safe to call when there is none, or when not [enabled]. */
    @Synchronized fun clear() {
        if (!enabled) return
        runCatching { Files.deleteIfExists(file.toPath()) }
        runCatching { Files.deleteIfExists(File(dir, "$FILE_NAME.tmp").toPath()) }
    }

    companion object {
        const val FILE_NAME = "local-link.json"

        /** `<files>/debug`. */
        fun dirIn(filesDir: File) = File(filesDir, "debug")

        /**
         * On only when the build is a debug build AND the installed package is debuggable (the flag `run-as` itself
         * requires, and the one a release signature never carries). Either one false is enough to keep it off.
         */
        fun enabledFor(buildDebug: Boolean, applicationFlags: Int) =
            buildDebug && (applicationFlags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
    }
}
