package ai.ash.link

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class HandIdentityTest {
    // A real P-256 public key. The id is what the gateway computes for it (ash-gateway/src/protocol.ts deviceIdForKey):
    //   node -e 'const c=require("node:crypto");const s=Buffer.from(SPKI,"base64url");
    //            console.log(c.createHash("sha256").update(s).digest("base64url").slice(0,22))'
    private val spki = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEI3p40ewWB5g41uB4JDvQ6fxRZa6RTZDamc9FDrVyiGy201Kdn8YdlloK7ncrF9531FMsBLg_Yr2cbHBRS_eijw"
    private val expectedId = "3h8LUAFUnZiOQDu3P0nyCB"

    private class FixedKey(val spki: ByteArray) : KeyBackend {
        override fun publicKeySpki() = spki
        override fun sign(data: ByteArray) = throw UnsupportedOperationException()
    }

    @Test fun theHandIdIsTheGatewaysHashOfTheKey() {
        val identity = HandIdentity(FixedKey(Base64.getUrlDecoder().decode(spki)))
        assertEquals(spki, identity.publicKey)
        assertEquals(expectedId, identity.handId)
        assertEquals(22, identity.handId.length)
    }

    @Test fun theSignatureIsDerOverTheNonceBytesAndVerifiesAgainstThePublicKey() {
        val backend = SoftKeyBackend()
        val identity = HandIdentity(backend)
        val sig = Base64.getUrlDecoder().decode(identity.sign("n0nce-1234"))
        assertEquals(0x30, sig[0].toInt())
        assertTrue(backend.verify("n0nce-1234".toByteArray(Charsets.UTF_8), sig))
        assertTrue(!backend.verify("another".toByteArray(Charsets.UTF_8), sig))
        assertTrue(!identity.sign("n0nce-1234").contains('=') && !identity.publicKey.contains('='))
    }
}
