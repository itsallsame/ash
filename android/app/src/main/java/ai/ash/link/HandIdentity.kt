package ai.ash.link

import java.security.MessageDigest
import java.util.Base64

/** The key pair under the hand's identity. On the phone it lives in the Android Keystore ([KeystoreKeyBackend]); a test supplies its own. */
interface KeyBackend {
    /** The public key as X.509 SubjectPublicKeyInfo DER. */
    fun publicKeySpki(): ByteArray
    /** An ECDSA P-256 / SHA-256 signature of [data], ASN.1 DER. */
    fun sign(data: ByteArray): ByteArray
}

/**
 * Who this hand is: the `ash-hand` EC P-256 key. The kernel knows the hand by `hand_id`, a hash of the public key
 * (the same derivation the gateway uses for device ids), and checks the signature of the challenge nonce against it.
 */
class HandIdentity(private val backend: KeyBackend) {
    private val spki: ByteArray by lazy { backend.publicKeySpki() }

    /** SPKI, base64url without padding: the `public_key` of `hello`. */
    val publicKey: String by lazy { b64u(spki) }

    /** base64url(SHA-256(SPKI)) cut to 22 characters. */
    val handId: String by lazy { handIdOf(spki) }

    /** Signs the challenge [nonce] (its UTF-8 bytes); base64url of the DER signature. */
    fun sign(nonce: String): String = b64u(backend.sign(nonce.toByteArray(Charsets.UTF_8)))

    companion object {
        fun handIdOf(spki: ByteArray): String = b64u(MessageDigest.getInstance("SHA-256").digest(spki)).substring(0, 22)

        fun b64u(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }
}
