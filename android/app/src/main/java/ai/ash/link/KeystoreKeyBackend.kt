package ai.ash.link

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/** The `ash-hand` key in the Android Keystore: created on first use, never exportable. */
class KeystoreKeyBackend(private val alias: String = ALIAS) : KeyBackend {
    private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    @Synchronized
    private fun ensure(): KeyStore {
        val ks = store()
        if (ks.containsAlias(alias)) return ks
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        generator.initialize(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        generator.generateKeyPair()
        return store()
    }

    override fun publicKeySpki(): ByteArray = ensure().getCertificate(alias).publicKey.encoded

    override fun sign(data: ByteArray): ByteArray {
        val key = ensure().getKey(alias, null) as PrivateKey
        return Signature.getInstance("SHA256withECDSA").run { initSign(key); update(data); sign() }
    }

    companion object { const val ALIAS = "ash-hand" }
}
