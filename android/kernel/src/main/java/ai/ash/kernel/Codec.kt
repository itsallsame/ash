package ai.ash.kernel

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** base64url without padding, the encoding of the host contract. */
object Codec {
    private val enc = Base64.getUrlEncoder().withoutPadding()
    private val dec = Base64.getUrlDecoder()
    private val random = SecureRandom()

    fun b64u(b: ByteArray): String = enc.encodeToString(b)

    /** Throws IllegalArgumentException on anything that is not base64url. */
    fun unb64u(s: String): ByteArray = dec.decode(s)

    /** The key id of the contract: the first 22 characters of the base64url SHA-256 of the SPKI public key. */
    fun keyId(spki: ByteArray): String = b64u(MessageDigest.getInstance("SHA-256").digest(spki)).substring(0, 22)

    fun randomToken(bytes: Int = 24): String = b64u(ByteArray(bytes).also { random.nextBytes(it) })
}
