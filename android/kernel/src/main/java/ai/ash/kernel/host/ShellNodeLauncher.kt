package ai.ash.kernel.host

import ai.ash.kernel.Codec
import ai.ash.kernel.HostApi
import ai.ash.kernel.HostSpecInput
import ai.ash.kernel.HostSpecWriter
import ai.ash.kernel.KernelHostServer
import ai.ash.kernel.NodeEnv
import ai.ash.kernel.NodeHandle
import ai.ash.kernel.NodeLauncher
import ai.ash.kernel.NodeProcess
import ai.ash.kernel.Paths
import ai.ash.kernel.RotatingLog
import ai.ash.kernel.SystemEnv
import android.util.Log
import java.io.File

/**
 * Starts the core the way [ai.ash.kernel.AndroidNodeLauncher] does, but as the shell user through `run-as`, so the core
 * runs under the kernel package's uid (its data is where it always was) while its parent is the shell host (outside the
 * package's process group and at oom_score_adj -1000 from adbd): the maker's background cleaning does not reach it.
 *
 * What only the kernel package's identity can do — the seal key, writing host.json into the package storage — is done
 * through the bridge. The log and the pid file go to a shell-writable directory (the shell cannot write the package's).
 */
class ShellNodeLauncher(
    private val bridge: IKernelBridge,
    private val kernelPackage: String,
    private val paths: Paths,
    private val sys: SystemEnv,
    private val api: HostApi,
    private val server: KernelHostServer,
    private val runDir: File,
    private val hostVersion: String,
) : NodeLauncher {
    private val log = RotatingLog(File(runDir, "logs"))

    override fun launch(): NodeHandle {
        val proxy = sys.proxy()
        val spec = HostSpecWriter.build(
            HostSpecInput(paths, hostVersion, sys.platform(), proxy, sys.dnsServers(), server.endpoint, api.capabilities),
        )
        bridge.writeHostSpec(spec.toString(2))
        val token = Codec.randomToken()
        val sealKey = bridge.sealKey()
        val env = NodeEnv.build(
            paths, paths.hostSpec.path, sealKey, token, proxy,
            System.getenv("ANDROID_DATA") ?: "/data", System.getenv("ANDROID_ROOT") ?: "/system",
        )
        // run-as enters the package's data as its uid; the core binary and data are the same ones the service would use.
        api.token = token
        return try {
            NodeProcess.start(runAs(NodeEnv.command(paths)), env, runDir, log, File(runDir, "node.pid"))
        } catch (e: Throwable) {
            api.token = null
            throw e
        } finally {
            env.clear()
        }
    }

    private fun runAs(nodeCommand: List<String>): List<String> {
        Log.i(TAG, "launching the core through run-as $kernelPackage")
        return listOf(RUN_AS, kernelPackage) + nodeCommand
    }

    companion object {
        private const val RUN_AS = "/system/bin/run-as"
        private const val TAG = "ash.kernel.host"
    }
}
