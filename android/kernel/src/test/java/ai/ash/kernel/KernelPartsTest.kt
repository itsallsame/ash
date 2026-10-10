package ai.ash.kernel

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class KernelPartsTest {
    private val dir = tempDir("kernel-parts")
    private val paths = Paths(File(dir, "files"), File(dir, "cache"))

    @After fun cleanup() { dir.deleteRecursively() }

    // ---- the core's environment

    @Test fun environmentIsExactlyTheThreeVariablesAndWhatRunningNeeds() {
        val env = NodeEnv.build(paths, "/spec/host.json", "SEAL", "TOKEN", Proxy.of("1.2.3.4:80"), "/data", "/system")
        assertEquals("/spec/host.json", env["ASH_HOST_SPEC"])
        assertEquals("SEAL", env["ASH_VAULT_SEAL_KEY"])
        assertEquals("TOKEN", env["ASH_HOST_TOKEN"])
        val allowed = setOf(
            "ASH_HOST_SPEC", "ASH_VAULT_SEAL_KEY", "ASH_HOST_TOKEN",
            "HOME", "PATH", "TMPDIR", "TMP", "LANG", "NODE_USE_ENV_PROXY", "ANDROID_DATA", "ANDROID_ROOT",
            "OPENSSL_CONF", "SSL_CERT_FILE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS",
            "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_CONFIG_NOSYSTEM", "GIT_PAGER", "PAGER",
            "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy",
        )
        assertEquals(emptySet<String>(), env.keys - allowed)
        assertEquals("http://1.2.3.4:80", env["HTTPS_PROXY"])
        assertEquals("${dir}/files", env["HOME"])
        assertEquals("${dir}/cache/tmp", env["TMPDIR"])
        assertEquals("C.UTF-8", env["LANG"])
        assertTrue(env["SSL_CERT_FILE"]!!.startsWith("${dir}/files/payload/"))
        // Nothing of the old protocol: no config file, no ports, no model keys.
        assertFalse(env.keys.any { it.startsWith("ASH_") && it !in setOf("ASH_HOST_SPEC", "ASH_VAULT_SEAL_KEY", "ASH_HOST_TOKEN") })
    }

    @Test fun noProxyMeansNoProxyVariables() {
        val env = NodeEnv.build(paths, "/s", "k", "t", null, "/data", "/system")
        assertFalse(env.keys.any { it.contains("proxy", ignoreCase = true) && it != "NODE_USE_ENV_PROXY" })
    }

    @Test fun commandRunsTheCoreBundleAndUsesThePreloadOnlyWhenItIsThere() {
        assertEquals(listOf(paths.node.path, paths.coreBundle.path), NodeEnv.command(paths))
        paths.compatPreload.parentFile!!.mkdirs()
        paths.compatPreload.writeText("")
        assertEquals(listOf(paths.node.path, "--expose-internals", "--require", paths.compatPreload.path, paths.coreBundle.path), NodeEnv.command(paths))
        assertEquals("${dir}/files/payload/runtime/bin/node", paths.node.path)
        assertEquals("${dir}/files/payload/ash/ash-core.mjs", paths.coreBundle.path)
    }

    // ---- log rotation

    @Test fun logRotatesAtTheLimitAndKeepsThreeFiles() {
        val log = RotatingLog(File(dir, "logs"), "core.log", maxBytes = 100, keep = 3)
        repeat(11) { n -> log.write(("x".repeat(60) + "<$n>\n").toByteArray()) }
        log.close()
        val names = File(dir, "logs").list()!!.sorted()
        assertEquals(listOf("core.log", "core.log.1", "core.log.2"), names)
        // The newest data is in the current file, older in .1, the oldest kept in .2; anything older is gone.
        fun text(n: String) = File(dir, "logs/$n").readText()
        assertTrue(text("core.log").contains("<10>"))
        assertTrue(text("core.log.1").contains("<8>") && text("core.log.1").contains("<9>"))
        assertTrue(text("core.log.2").contains("<6>") && text("core.log.2").contains("<7>"))
        assertFalse((text("core.log") + text("core.log.1") + text("core.log.2")).contains("<5>"))
    }

    @Test fun logNoteCarriesAHostTag() {
        val log = RotatingLog(File(dir, "logs"))
        log.note("ash core started")
        log.close()
        assertTrue(File(dir, "logs/core.log").readText().contains("[host] ash core started"))
    }

    // ---- wake

    @Test fun wakeKeepsOnlyTheEarliestAlarm() {
        val alarms = FakeAlarms()
        val wake = WakeManager(alarms)
        wake.at(5_000)
        wake.at(9_000)
        assertEquals(listOf(5_000L), alarms.sets)
        wake.at(3_000)
        assertEquals(listOf(5_000L, 3_000L), alarms.sets)
        wake.fired(3_000)
        assertEquals(null, wake.pending())
        wake.at(9_000)
        assertEquals(9_000L, alarms.sets.last())
        wake.clear()
        assertEquals(1, alarms.cancels)
        assertEquals(null, wake.pending())
    }

    // ---- small helpers

    @Test fun keyIdIsTheFirst22CharsOfTheBase64urlSha256() {
        val spki = SoftIdentity().publicKey()
        val id = Codec.keyId(spki)
        assertEquals(22, id.length)
        assertTrue(id.matches(Regex("[A-Za-z0-9_-]{22}")))
    }

    @Test fun tokensAreFreshAndUrlSafe() {
        val a = Codec.randomToken()
        assertTrue(a.matches(Regex("[A-Za-z0-9_-]{32}")))
        assertFalse(a == Codec.randomToken())
    }

    @Test fun dnsOrderPutsIpv4FirstAndFallsBack() {
        assertEquals(listOf("8.8.8.8", "fe80::1"), SystemEnv.orderDns(listOf("fe80::1", "8.8.8.8", "8.8.8.8", " ")))
        assertEquals(SystemEnv.FALLBACK_DNS, SystemEnv.orderDns(emptyList()))
    }

    @Test fun abiNamesBecomeNodeArchNames() {
        assertEquals("arm64", SystemEnv.archOf("arm64-v8a"))
        assertEquals("x64", SystemEnv.archOf("x86_64"))
    }

    @Test fun proxyEnvCarriesNoProxyToo() {
        val env = proxyEnv(Proxy.of("h:1"))
        assertEquals("127.0.0.1,localhost,::1", env["NO_PROXY"])
        assertEquals(emptyMap<String, String>(), proxyEnv(null))
    }
}
