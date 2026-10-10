package ai.ash.kernel

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.IOException

/** The few file operations the swap needs; none of them follows a symlink. */
interface TreeOps {
    fun exists(f: File): Boolean
    fun isRealDir(f: File): Boolean
    fun rename(from: File, to: File)
    fun deleteTree(f: File)
}

/**
 * Finishes or undoes an interrupted install. States (each reached by one rename):
 *  - staging only (crash while extracting): discard it.
 *  - old without root (crash between the two swap renames): put old back.
 *  - old with root: move old/ubuntu/root into root (the shipped ubuntu/root is set aside as
 *    root.shipped and only what the user's root lacks is taken from it), then drop old.
 * Idempotent: running it again after a crash at any step reaches the same end state.
 */
class ContainerSwap(private val root: File, private val old: File, private val staging: File, private val ops: TreeOps) {
    fun recover() {
        val oldHome = File(old, "ubuntu/root")
        if (ops.exists(old) && !ops.exists(root)) ops.rename(old, root)
        if (ops.exists(old)) {
            val ubuntu = File(root, "ubuntu")
            val home = File(ubuntu, "root")
            val shipped = File(ubuntu, "root.shipped")
            if (ops.exists(oldHome)) {
                // While the user's home is still in old, `home` (if any) is the shipped one.
                if (ops.exists(home)) {
                    ops.deleteTree(shipped)
                    ops.rename(home, shipped)
                }
                ubuntu.mkdirs()
                ops.rename(oldHome, home)
            }
            if (ops.exists(shipped)) {
                mergeMissing(shipped, home)
                ops.deleteTree(shipped)
            }
            ops.deleteTree(old)
        }
        if (ops.exists(staging)) ops.deleteTree(staging)
    }

    /** Moves into [to] every entry of [from] that [to] lacks (recursing into directories both have). */
    private fun mergeMissing(from: File, to: File) {
        if (!ops.exists(to)) {
            ops.rename(from, to)
            return
        }
        if (!ops.isRealDir(from) || !ops.isRealDir(to)) return
        for (name in from.list().orEmpty()) mergeMissing(File(from, name), File(to, name))
    }
}

object AndroidTreeOps : TreeOps {
    private const val TAG = "ash.kernel.container"

    override fun rename(from: File, to: File) {
        try {
            Os.rename(from.path, to.path)
        } catch (e: ErrnoException) {
            throw IOException("cannot move ${from.name} to ${to.name}: ${e.message}", e)
        }
    }

    override fun exists(f: File): Boolean = try { Os.lstat(f.path); true } catch (e: ErrnoException) { false }

    override fun isRealDir(f: File): Boolean = try {
        OsConstants.S_ISDIR(Os.lstat(f.path).st_mode)
    } catch (e: ErrnoException) {
        false
    }

    /**
     * rm -rf that never follows a symlink: the container is full of links (absolute ones point at
     * host paths outside it), and File.deleteRecursively would descend into their targets.
     * Directories without write permission are opened up first (the owner may always chmod).
     */
    override fun deleteTree(f: File) {
        val st = try { Os.lstat(f.path) } catch (e: ErrnoException) { return }
        if (OsConstants.S_ISDIR(st.st_mode)) {
            if ((st.st_mode and 448 /* 0700 */) != 448) try { Os.chmod(f.path, 448) } catch (_: ErrnoException) {}
            for (name in f.list().orEmpty()) deleteTree(File(f, name))
            try { Os.remove(f.path) } catch (e: ErrnoException) { Log.w(TAG, "rmdir ${f.path}: ${e.message}") }
        } else {
            try { Os.remove(f.path) } catch (e: ErrnoException) { Log.w(TAG, "remove ${f.path}: ${e.message}") }
        }
    }
}
