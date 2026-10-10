package ai.ash.kernel

import android.content.Context
import java.io.File

/**
 * Where everything lives in the package's private storage. The payload is replaceable (package updates swap it);
 * everything under ash/ and the container's ubuntu/root is the owner's and survives.
 */
class Paths(val files: File, val cache: File) {
    constructor(ctx: Context) : this(ctx.filesDir, ctx.cacheDir)

    /** Extracted payload: runtime/ (node, git, python ...), dsh/ (DSH as published), ash/ (ash core), bin/, profile/. */
    val payload = File(files, "payload")
    val payloadStaging = File(files, "payload.new")
    val payloadOld = File(files, "payload.old")

    /** The host's run directory: host.json, the ledger and member state, the vault's wrapped seal key, logs. */
    val ash = File(files, "ash")
    val state = File(ash, "state")
    val logs = File(ash, "logs")
    val hostSpec = File(ash, "host.json")
    val vaultKey = File(ash, "vault.key")
    val nodePid = File(ash, "node.pid")

    val tmp = File(cache, "tmp")

    /**
     * The agent container (proot + Ubuntu + DSH), shipped in the APK and extracted by ContainerInstaller.
     * Everything but ubuntu/root is replaced on an upgrade; ubuntu/root (workspace, DSH home) is the owner's.
     */
    val containers = File(files, "container")
    val containerRoot = File(containers, "main")
    val containerStaging = File(containers, "main.new")
    val containerOld = File(containers, "main.old")
    val containerVersion = File(containerRoot, "VERSION")
    val rootfs = File(containerRoot, "ubuntu")
    val prootBin = File(containerRoot, "proot/bin/proot")
    val prootLoader = File(containerRoot, "proot/libexec/loader")
    val prootLib = File(containerRoot, "proot/lib")

    /** Ash's home: the host-side path of /root/work in the main body. */
    val home = File(rootfs, "root/work")

    // ---- the payload's own layout
    val node = File(payload, "runtime/bin/node")
    val coreBundle = File(payload, "ash/ash-core.mjs")
    val compatPreload = File(payload, "dsh/lib/node_modules/android-node-compat/index.cjs")
    val buildMarker = File(payload, ".build")
}
