package ai.ash.host

import ai.ash.BuildConfig
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Installs the kernel package when it is missing (SPEC-05 §9 step 1): downloads it from the release address built into
 * this app, checks it is signed like this app (a package signed otherwise could never be given the signature
 * permissions anyway) and hands it to the system installer, which asks the owner. Nothing here runs unless the owner
 * pressed the button in the guide.
 */
object KernelInstaller {
    private const val TAG = "ash.kernel"
    private const val STATUS_ACTION = "ai.ash.agent.KERNEL_INSTALL_STATUS"
    private const val MAX_BYTES = 1L shl 30
    @Suppress("DEPRECATION") private val SIGNERS = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES

    /** The package's address; empty when this build has none (then the owner installs the kernel package another way). */
    val url: String get() = BuildConfig.KERNEL_APK_URL

    val configured: Boolean get() = url.startsWith("https://")

    /** What the system installer last said, for the guide to show; null while nothing failed. */
    @Volatile var failure: String? = null

    fun mayInstall(ctx: Context): Boolean = ctx.packageManager.canRequestPackageInstalls()

    /** The system page where the owner allows this app to install packages. */
    fun allowIntent(ctx: Context): Intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))

    /** Downloads the package; blocks. [progress] gets (bytes so far, total or -1). Throws on any failure. */
    fun download(ctx: Context, progress: (Long, Long) -> Unit): File {
        require(configured) { "no https address for the kernel package in this build" }
        val dir = File(ctx.cacheDir, "kernel").apply { mkdirs() }
        val part = File(dir, "kernel.apk.part")
        val target = File(dir, "kernel.apk")
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000; conn.readTimeout = 30_000
        try {
            check(conn.responseCode == 200) { "download answered ${conn.responseCode}" }
            val total = conn.contentLengthLong
            check(total <= MAX_BYTES) { "the package is too large" }
            var done = 0L
            conn.inputStream.use { input -> part.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n); done += n
                    check(done <= MAX_BYTES) { "the package is too large" }
                    progress(done, total)
                }
            } }
        } finally { conn.disconnect() }
        target.delete()
        check(part.renameTo(target)) { "could not keep the download" }
        return target
    }

    /** Why [apk] must not be installed, or null when it may be. */
    fun problem(ctx: Context, apk: File): String? {
        val info = ctx.packageManager.getPackageArchiveInfo(apk.path, SIGNERS) ?: return "下载的文件不是安装包"
        if (info.packageName != KernelLauncher.PACKAGE) return "下载的不是大脑的安装包"
        val mine = ctx.packageManager.getPackageInfo(ctx.packageName, SIGNERS)
        return if (sameSigners(signers(info), signers(mine))) null else "大脑的安装包的签名和 Ash 不一致"
    }

    private fun signers(info: android.content.pm.PackageInfo): List<ByteArray> =
        (if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else @Suppress("DEPRECATION") info.signatures)?.map { it.toByteArray() }.orEmpty()

    /** The two packages are signed by the same set of certificates (and by at least one). */
    fun sameSigners(a: List<ByteArray>, b: List<ByteArray>): Boolean {
        fun digests(l: List<ByteArray>) = l.map { MessageDigest.getInstance("SHA-256").digest(it).toList() }.toSet()
        return a.isNotEmpty() && digests(a) == digests(b)
    }

    /** Hands [apk] to the system installer; its answer comes to [KernelInstallReceiver]. */
    fun install(ctx: Context, apk: File) {
        failure = null
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply { setAppPackageName(KernelLauncher.PACKAGE) }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            apk.inputStream().use { input -> session.openWrite("kernel.apk", 0, apk.length()).use { out -> input.copyTo(out); session.fsync(out) } }
            val status = PendingIntent.getBroadcast(ctx, id, Intent(ctx, KernelInstallReceiver::class.java).setAction(STATUS_ACTION),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            session.commit(status.intentSender)
        }
    }

    internal fun onStatus(ctx: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION") val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirm != null) BackgroundLaunch.start(ctx, confirm, "确认安装 Ash 大脑", "点这里确认安装")
            }
            PackageInstaller.STATUS_SUCCESS -> { failure = null; Log.i(TAG, "kernel package installed") }
            else -> {
                failure = "大脑的安装包没装上（${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "代码 $status"}）"
                Log.w(TAG, "kernel install failed: $status")
            }
        }
    }
}

/** The system installer's progress for the kernel package. */
class KernelInstallReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) = KernelInstaller.onStatus(ctx.applicationContext, intent)
}
