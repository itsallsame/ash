package ai.ash.kernel

import android.content.Context
import android.os.StatFs
import android.system.Os
import android.util.Log
import java.io.File
import java.io.IOException

/**
 * Installs the agent container shipped in the APK (assets/container/ash-container.tgz + VERSION,
 * built by tools/build-container-rootfs.mjs) into files/container/main:
 *
 *   VERSION, proot/ (Termux proot), ubuntu/ (the root filesystem), tmp/ (created here, proot's /tmp)
 *
 * The archive is streamed into the system `tar` (symlinks and modes survive; app storage allows no
 * hard links, and the archive carries none). A new version is extracted into main.new and swapped
 * in with renames; the user's part of the old tree, ubuntu/root (workspace, DSH home, anything
 * installed there), is carried over. Every step is a rename that [ContainerSwap.recover] can finish
 * or undo, so a crash at any point never loses ubuntu/root and never leaves a half-extracted
 * container active.
 */
object ContainerInstaller {
    private const val TAG = "ash.kernel.container"
    private const val ASSET = "container/ash-container.tgz"
    private const val ASSET_VERSION = "container/VERSION"
    private const val TAR = "/system/bin/tar"
    /** Unpacked size is ~620 MB; keep room for the phone itself. */
    private const val NEED_BYTES = 900L * 1024 * 1024

    fun shippedVersion(ctx: Context): String? = try {
        ctx.assets.open(ASSET_VERSION).use { it.readBytes().toString(Charsets.UTF_8).trim() }.ifEmpty { null }
    } catch (e: IOException) {
        null
    }

    fun installedVersion(p: Paths): String? =
        if (p.containerVersion.exists()) p.containerVersion.readText().trim().ifEmpty { null } else null

    /** True when [ensure] has work to do: a new shipped version, or an interrupted earlier run. */
    fun needsWork(ctx: Context, p: Paths): Boolean {
        if (p.containerOld.exists() || p.containerStaging.exists()) return true
        val shipped = shippedVersion(ctx) ?: return false // a build without a container keeps what is there
        return installedVersion(p) != shipped || !File(p.containerRoot, "proot/bin/proot").exists() || !File(p.containerRoot, "tmp").isDirectory
    }

    /**
     * Makes files/container/main hold the shipped version. `progress(percent)` reports extraction
     * (-1 when the size is unknown). Must not run while anything uses the container.
     */
    @Synchronized
    fun ensure(ctx: Context, p: Paths, progress: (Int) -> Unit = {}) {
        p.containers.mkdirs()
        recover(p)
        val shipped = shippedVersion(ctx) ?: return
        if (installedVersion(p) != shipped || !File(p.containerRoot, "proot/bin/proot").exists()) {
            install(ctx, p, shipped, progress)
        }
        prepare(p.containerRoot)
    }

    private fun install(ctx: Context, p: Paths, version: String, progress: (Int) -> Unit) {
        require(File(TAR).exists()) { "这台手机缺少系统 tar，无法准备工作环境" }
        val free = StatFs(p.files.path).availableBytes
        require(free > NEED_BYTES) { "存储空间不足：准备工作环境需要约 900 MB，当前可用 ${free / 1024 / 1024} MB" }

        deleteTree(p.containerStaging)
        p.containerStaging.mkdirs()
        extract(ctx, p.containerStaging, progress)
        val got = File(p.containerStaging, "VERSION").takeIf { it.exists() }?.readText()?.trim()
        check(got == version) { "container archive says VERSION $got, expected $version" }
        prepare(p.containerStaging)

        // Swap: main -> main.old, main.new -> main, then carry ubuntu/root over (see recover()).
        if (p.containerRoot.exists()) rename(p.containerRoot, p.containerOld)
        rename(p.containerStaging, p.containerRoot)
        recover(p)
        Log.i(TAG, "container $version installed")
    }

    /** Streams the asset into `tar -xzf - -C dir`. */
    private fun extract(ctx: Context, dir: File, progress: (Int) -> Unit) {
        val total = try { ctx.assets.openFd(ASSET).use { it.length } } catch (e: IOException) { -1L }
        val errLog = File(dir.parentFile, "extract.log")
        val proc = ProcessBuilder(TAR, "-xzf", "-", "-C", dir.path)
            .redirectErrorStream(true)
            .redirectOutput(errLog)
            .start()
        var done = 0L
        var last = -2
        try {
            ctx.assets.open(ASSET).use { input ->
                proc.outputStream.use { out ->
                    val buf = ByteArray(1 shl 20)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        val pct = if (total > 0) (done * 100 / total).toInt().coerceAtMost(99) else -1
                        if (pct != last) { last = pct; progress(pct) }
                    }
                }
            }
        } catch (e: IOException) {
            proc.destroy()
            throw IOException("解压工作环境失败：${errLog.takeIf { it.exists() }?.readText()?.takeLast(400) ?: e.message}", e)
        }
        val code = proc.waitFor()
        val err = errLog.takeIf { it.exists() }?.readText().orEmpty()
        errLog.delete()
        check(code == 0) { "解压工作环境失败（tar $code）：${err.takeLast(400)}" }
        progress(100)
    }

    /** What the archive cannot carry: proot's tmp dir, and executable bits we rely on. */
    private fun prepare(root: File) {
        File(root, "tmp").mkdirs()
        for (f in listOf("proot/bin/proot", "proot/libexec/loader", "proot/lib/libtalloc.so.2", "proot/lib/libandroid-shmem.so")) {
            val file = File(root, f)
            if (file.exists()) Os.chmod(file.path, 493 /* 0755 */)
        }
        File(root, "ubuntu/root/work").mkdirs()
        File(root, "ubuntu/root/.dsh").mkdirs()
    }

    fun recover(p: Paths) = ContainerSwap(p.containerRoot, p.containerOld, p.containerStaging, AndroidTreeOps).recover()

    fun deleteTree(f: File) = AndroidTreeOps.deleteTree(f)

    private fun rename(from: File, to: File) = AndroidTreeOps.rename(from, to)
}
