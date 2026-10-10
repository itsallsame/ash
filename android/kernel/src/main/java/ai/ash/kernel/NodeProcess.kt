package ai.ash.kernel

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/** Signals to a process by pid. The Android implementation uses kill(2); tests use their own. */
interface ProcessSignals {
    fun term(pid: Int)
    fun kill(pid: Int)
    /** Signal 0: exists and is ours. */
    fun alive(pid: Int): Boolean
}

object OsSignals : ProcessSignals {
    override fun term(pid: Int) { try { Os.kill(pid, OsConstants.SIGTERM) } catch (_: ErrnoException) {} }
    override fun kill(pid: Int) { try { Os.kill(pid, OsConstants.SIGKILL) } catch (_: ErrnoException) {} }
    override fun alive(pid: Int): Boolean = try { Os.kill(pid, 0); true } catch (_: ErrnoException) { false }
}

/** A running (or finished) core process, as the supervisor sees it. */
interface NodeHandle {
    fun isRunning(): Boolean

    /** One host event line on the core's standard input. False when the pipe is gone. */
    fun writeEvent(line: String): Boolean

    /** [stopLine] (lifecycle.stop) first and wait up to [graceMs] for a clean exit; then SIGTERM, then SIGKILL. */
    fun stop(stopLine: String?, graceMs: Long)
}

/** The environment of the core process, and the command that starts it. */
object NodeEnv {
    /**
     * Cleared environment plus exactly: the three variables of the host contract, and what running needs (HOME, PATH,
     * TMPDIR, LANG, certificate paths, the proxy, and the payload's git/openssl locations).
     */
    fun build(p: Paths, specPath: String, sealKey: String, hostToken: String, proxy: Proxy?, androidData: String, androidRoot: String): MutableMap<String, String> {
        val pl = p.payload.path
        val cert = "$pl/runtime/etc/tls/cert.pem"
        val env = LinkedHashMap<String, String>()
        env.putAll(proxyEnv(proxy))
        env.putAll(
            mapOf(
                "ASH_HOST_SPEC" to specPath,
                "ASH_VAULT_SEAL_KEY" to sealKey,
                "ASH_HOST_TOKEN" to hostToken,
                // Core's own fetch honours HTTP(S)_PROXY with this.
                "NODE_USE_ENV_PROXY" to "1",
                "HOME" to p.files.path,
                "PATH" to "$pl/runtime/bin:/system/bin:/system/xbin",
                "TMPDIR" to p.tmp.path,
                "TMP" to p.tmp.path,
                "LANG" to "C.UTF-8",
                // The payload's OpenSSL looks under Termux's prefix otherwise (EACCES when Termux is installed).
                "OPENSSL_CONF" to "$pl/runtime/etc/tls/openssl.cnf",
                "SSL_CERT_FILE" to cert,
                "CURL_CA_BUNDLE" to cert,
                "GIT_SSL_CAINFO" to cert,
                "NODE_EXTRA_CA_CERTS" to cert,
                "GIT_EXEC_PATH" to "$pl/runtime/libexec/git-core",
                "GIT_TEMPLATE_DIR" to "$pl/runtime/share/git-core/templates",
                "GIT_CONFIG_NOSYSTEM" to "1",
                "GIT_PAGER" to "cat",
                "PAGER" to "cat",
                "ANDROID_DATA" to androidData,
                "ANDROID_ROOT" to androidRoot,
            ),
        )
        return env
    }

    /** `<runtime>/node [preload] ash-core.mjs`. The preload adapts hard links and flock where the platform refuses them. */
    fun command(p: Paths): List<String> {
        val cmd = ArrayList<String>()
        cmd.add(p.node.path)
        if (p.compatPreload.exists()) cmd.addAll(listOf("--expose-internals", "--require", p.compatPreload.path))
        cmd.add(p.coreBundle.path)
        return cmd
    }
}

/**
 * ash core as a child process. The host is its parent: standard input carries host events (one JSON object per line),
 * standard output and error go to the rotating log.
 */
class NodeProcess private constructor(
    private val proc: Process,
    val pid: Int,
    private val signals: ProcessSignals,
    private val log: RotatingLog,
) : NodeHandle {
    private val stdin = proc.outputStream

    init {
        Thread({
            val buf = ByteArray(16 * 1024)
            try {
                val input = proc.inputStream
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    log.write(buf, 0, n)
                }
            } catch (_: IOException) {
            }
        }, "ash-node-log").apply { isDaemon = true; start() }
    }

    override fun isRunning(): Boolean = proc.isAlive

    @Synchronized
    override fun writeEvent(line: String): Boolean = try {
        stdin.write((line + "\n").toByteArray(Charsets.UTF_8))
        stdin.flush()
        true
    } catch (_: IOException) {
        false
    }

    override fun stop(stopLine: String?, graceMs: Long) {
        if (stopLine != null && proc.isAlive) writeEvent(stopLine)
        if (stopLine != null && waitFor(graceMs)) return
        if (!proc.isAlive) return
        if (pid > 0) signals.term(pid) else proc.destroy()
        if (waitFor(TERM_WAIT_MS)) return
        if (pid > 0) signals.kill(pid) else proc.destroyForcibly()
        waitFor(TERM_WAIT_MS)
    }

    private fun waitFor(ms: Long): Boolean = try { proc.waitFor(ms, TimeUnit.MILLISECONDS) } catch (_: InterruptedException) { !proc.isAlive }

    companion object {
        private const val TERM_WAIT_MS = 3_000L

        fun start(
            command: List<String>, env: Map<String, String>, workDir: File, log: RotatingLog, pidFile: File?,
            signals: ProcessSignals = OsSignals,
        ): NodeProcess {
            val pb = ProcessBuilder(command).directory(workDir)
            pb.environment().clear()
            pb.environment().putAll(env)
            pb.redirectErrorStream(true)
            val proc = pb.start()
            // The child has its copy; nothing of ours keeps the secrets.
            pb.environment().clear()
            val pid = pidOf(proc)
            try { pidFile?.writeText("$pid\n") } catch (_: IOException) {}
            return NodeProcess(proc, pid, signals, log)
        }

        private fun pidOf(proc: Process): Int = try {
            proc.javaClass.getDeclaredField("pid").apply { isAccessible = true }.getInt(proc)
        } catch (_: Throwable) {
            -1
        }

        /**
         * A core left over from an earlier host process (it cannot be reattached to: its standard input belonged to
         * the old host). Alive, ours, and either invisible in /proc (a non-dumpable process of this user is) or visible
         * with our bundle on its command line: stop it, so there is one core only.
         */
        fun reapStale(pidFile: File, bundle: File, signals: ProcessSignals = OsSignals, note: (String) -> Unit = {}) {
            val recorded = try { pidFile.readText().trim().toIntOrNull() } catch (_: IOException) { null } ?: return
            if (!signals.alive(recorded)) return
            val cmd = try { File("/proc/$recorded/cmdline").readBytes().toString(Charsets.UTF_8).replace('\u0000', ' ') } catch (_: Exception) { null }
            if (cmd != null && cmd.isNotEmpty() && !cmd.contains(bundle.path)) return
            note("stopping a core left over from an earlier host (pid $recorded)")
            signals.term(recorded)
            for (i in 0 until 30) {
                Thread.sleep(100)
                if (!signals.alive(recorded)) return
            }
            signals.kill(recorded)
        }
    }
}

/** A one-thread scheduler for the hand connector's retries. */
class ExecutorScheduler : Scheduler {
    private val exec: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "ash-rebind").apply { isDaemon = true } }

    override fun schedule(delayMs: Long, task: () -> Unit): () -> Unit {
        val f = exec.schedule(task, delayMs, TimeUnit.MILLISECONDS)
        return { f.cancel(false) }
    }

    fun shutdown() { exec.shutdownNow() }
}
