package ai.ash.kernel

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermission

class HostSpecWriterTest {
    private val dir = tempDir("kernel-spec")
    private val paths = Paths(java.io.File(dir, "files"), java.io.File(dir, "cache"))
    private val platform = Platform("android", "15", "arm64", "OPPO Find X8", "zh-CN", "Asia/Shanghai")

    @After fun cleanup() { dir.deleteRecursively() }

    private fun input(proxy: Proxy? = null, capabilities: List<String> = HostApi.CAPABILITIES, debuggable: Boolean = false) =
        HostSpecInput(paths, "0.4.0", platform, proxy, listOf("223.5.5.5", "119.29.29.29"), capabilities, debuggable = debuggable)

    private fun problems(spec: JSONObject) = MiniSchema.validate(MiniSchema.load(), spec)

    @Test fun generatedSpecSatisfiesTheContractSchema() {
        assertEquals(emptyList<String>(), problems(HostSpecWriter.build(input())))
        val proxy = Proxy.of("192.168.1.2:7890")
        assertEquals(emptyList<String>(), problems(HostSpecWriter.build(input(proxy))))
    }

    @Test fun theScriptAgentIsAskedForOnlyByADebugBuild() {
        assertFalse(HostSpecWriter.build(input(debuggable = false)).getJSONObject("dev").getBoolean("script_agent"))
        val debug = HostSpecWriter.build(input(debuggable = true))
        assertTrue(debug.getJSONObject("dev").getBoolean("script_agent"))
        assertEquals(emptyList<String>(), problems(debug))
    }

    @Test fun theValidatorCatchesBrokenSpecs() {
        val good = HostSpecWriter.build(input()).toString()
        fun broken(edit: (JSONObject) -> Unit) = problems(JSONObject(good).also(edit))
        assertTrue(broken { it.put("contract", "ash-host/2") }.isNotEmpty())
        assertTrue(broken { it.put("network", JSONObject()) }.isNotEmpty())
        assertTrue(broken { it.put("secure_storage", "plaintext") }.isNotEmpty())
        assertTrue(broken { it.getJSONObject("isolation").remove("proot") }.isNotEmpty())
    }

    @Test fun fieldsAreWhatTheSpecSays() {
        val s = HostSpecWriter.build(input())
        assertEquals("ash-host/1", s.getString("contract"))
        assertEquals("android", s.getJSONObject("host").getString("kind"))
        assertEquals("0.4.0", s.getJSONObject("host").getString("version"))
        assertEquals("keystore", s.getString("secure_storage"))
        assertFalse(s.getJSONObject("dev").getBoolean("owner_token"))
        assertFalse("no address: the host and the core talk over a pipe", s.has("endpoint"))
        val dirs = s.getJSONObject("dirs")
        assertEquals("${dir}/files/ash/state", dirs.getString("state"))
        assertEquals("${dir}/files/payload", dirs.getString("runtime"))
        assertEquals("${dir}/files/ash/logs", dirs.getString("logs"))
        assertEquals("${dir}/cache/tmp", dirs.getString("tmp"))
        // Ash's home is /root/work of the main body, seen from the host.
        val proot = s.getJSONObject("isolation").getJSONObject("proot")
        assertEquals("proot", s.getJSONObject("isolation").getString("kind"))
        assertEquals("${proot.getString("rootfs")}/root/work", dirs.getString("home"))
        assertEquals("${dir}/files/container/main/proot/bin/proot", proot.getString("bin"))
        assertEquals("${dir}/files/container/main/proot/libexec/loader", proot.getString("loader"))
        assertEquals("/sdcard:/sdcard", proot.getJSONArray("storage_binds").getString(0))
        assertEquals("/storage/emulated/0:/storage/emulated/0", proot.getJSONArray("storage_binds").getString(1))
        assertEquals("223.5.5.5", proot.getJSONArray("dns").getString(0))
        assertTrue(s.getJSONObject("network").isNull("proxy"))
        // update.install is not implemented, so the group is not declared.
        val caps = s.getJSONArray("capabilities").let { a -> (0 until a.length()).map { a.getString(it) } }
        assertEquals(listOf("identity", "lifecycle", "status", "wake", "power", "hands"), caps)
    }

    @Test fun proxyIsWrappedInProxy() {
        val net = HostSpecWriter.build(input(Proxy.of("10.0.0.2:8080"))).getJSONObject("network").getJSONObject("proxy")
        assertEquals("http://10.0.0.2:8080", net.getString("http"))
        assertEquals("http://10.0.0.2:8080", net.getString("https"))
        assertEquals("127.0.0.1,localhost,::1", net.getString("no_proxy"))
    }

    @Test fun writtenFileIsOwnerOnlyAndCompleteJson() {
        HostSpecWriter.write(input())
        val f = paths.hostSpec
        assertTrue(f.exists())
        assertFalse(java.io.File(f.path + ".tmp").exists())
        assertEquals(setOf(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE), Files.getPosixFilePermissions(f.toPath()))
        assertEquals(emptyList<String>(), problems(JSONObject(f.readText())))
    }

    @Test fun noSecretsInTheFile() {
        val text = HostSpecWriter.build(input()).toString()
        // The seal key travels over the core's private pipe, never in the file.
        assertFalse(text.contains("seal", ignoreCase = true))
        assertFalse(text.contains("Bearer"))
    }
}
