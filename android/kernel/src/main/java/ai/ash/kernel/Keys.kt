package ai.ash.kernel

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** The owner identity behind identity.key / identity.sign: a public key and signatures, never the private key. */
interface Identity {
    /** SPKI (DER) of the public key. */
    fun publicKey(): ByteArray

    /** ECDSA P-256 over SHA-256, DER. */
    fun sign(data: ByteArray): ByteArray
}

/** Keys in the Android Keystore: the owner identity (`ash-owner`) and the key that wraps the vault's seal key (`ash-vault-wrap`). */
object Keys : Identity {
    private const val OWNER = "ash-owner"
    private const val VAULT_WRAP = "ash-vault-wrap"

    private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    @Synchronized
    fun ensureOwner() {
        if (store().containsAlias(OWNER)) return
        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        kpg.initialize(
            KeyGenParameterSpec.Builder(OWNER, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        kpg.generateKeyPair()
    }

    override fun publicKey(): ByteArray {
        ensureOwner()
        return store().getCertificate(OWNER).publicKey.encoded
    }

    override fun sign(data: ByteArray): ByteArray {
        ensureOwner()
        val key = store().getKey(OWNER, null) as PrivateKey
        return Signature.getInstance("SHA256withECDSA").run { initSign(key); update(data); sign() }
    }

    /**
     * The key that seals core's credential vault on disk: 32 random bytes, stored only wrapped by a non-exportable
     * Keystore key (file: IV, then AES-GCM ciphertext). The caller hands it to the core process and zeroes it.
     */
    @Synchronized
    fun vaultSealKey(file: File): ByteArray {
        val ks = store()
        if (!ks.containsAlias(VAULT_WRAP)) {
            val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            kg.init(
                KeyGenParameterSpec.Builder(VAULT_WRAP, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            kg.generateKey()
        }
        val wrap = ks.getKey(VAULT_WRAP, null) as SecretKey
        if (file.exists()) {
            val sealed = file.readBytes()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, wrap, GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
            return cipher.doFinal(sealed.copyOfRange(12, sealed.size))
        }
        val raw = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrap)
        val sealed = cipher.iv + cipher.doFinal(raw)
        file.parentFile?.mkdirs()
        val tmp = File(file.path + ".tmp")
        tmp.writeBytes(sealed)
        if (!tmp.renameTo(file)) throw IllegalStateException("vault key could not be stored")
        return raw
    }
}
