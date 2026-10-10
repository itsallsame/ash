package ai.ash.kernel

import android.content.Context

/** Installs the payload and the container from the APK's assets. */
class AndroidProvisioner(private val ctx: Context, private val paths: Paths) : Provisioner {
    override fun needsWork(): Boolean = !PayloadInstaller.upToDate(ctx, paths) || ContainerInstaller.needsWork(ctx, paths)

    override fun run(progress: (String) -> Unit) {
        if (!PayloadInstaller.upToDate(ctx, paths)) {
            progress("正在安装运行环境…")
            PayloadInstaller.install(ctx, paths) { done, total ->
                progress("正在安装运行环境… ${if (total > 0) "${done * 100 / total}%" else done}")
            }
        }
        if (ContainerInstaller.needsWork(ctx, paths)) {
            progress("正在准备 Ash 的工作环境…")
            var shown = -1
            ContainerInstaller.ensure(ctx, paths) { pct ->
                if (pct >= 0 && pct / 5 != shown) {
                    shown = pct / 5
                    progress("正在准备 Ash 的工作环境… $pct%")
                }
            }
        }
    }
}

/**
 * Starts the core: a fresh host token, host.json, the seal key (unwrapped by the Keystore for this start only), the
 * three environment variables, and the process. The token goes to [api] (so its calls are accepted) and to the core.
 */
class AndroidNodeLauncher(
    private val ctx: Context,
    private val paths: Paths,
    private val sys: SystemEnv,
    private val api: HostApi,
    private val server: KernelHostServer,
    private val log: RotatingLog,
    private val hostVersion: String,
) : NodeLauncher {
    override fun launch(): NodeHandle {
        Keys.ensureOwner()
        for (d in listOf(paths.ash, paths.state, paths.logs, paths.tmp, paths.home)) d.mkdirs()
        val proxy = sys.proxy()
        HostSpecWriter.write(
            HostSpecInput(paths, hostVersion, sys.platform(), proxy, sys.dnsServers(), server.endpoint, api.capabilities),
        )
        val token = Codec.randomToken()
        val raw = Keys.vaultSealKey(paths.vaultKey)
        val env = try {
            NodeEnv.build(
                paths, paths.hostSpec.path, Codec.b64u(raw), token, proxy,
                System.getenv("ANDROID_DATA") ?: "/data", System.getenv("ANDROID_ROOT") ?: "/system",
            )
        } finally {
            raw.fill(0)
        }
        // The token is valid from the moment the process exists: it may call the host interface before this returns.
        api.token = token
        val node = try {
            NodeProcess.start(NodeEnv.command(paths), env, paths.ash, log, paths.nodePid)
        } catch (e: Throwable) {
            api.token = null
            throw e
        } finally {
            env.clear()
        }
        log.note("ash core started (pid ${node.pid})")
        return node
    }
}
