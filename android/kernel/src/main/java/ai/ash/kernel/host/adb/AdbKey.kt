// Adapted from Shizuku (https://github.com/RikkaApps/Shizuku), manager/.../adb/AdbKey.kt, Apache License 2.0
// (see THIRD_PARTY_NOTICES.md). Changes: the key is kept in a file of its own; the certificate is made with okhttp-tls
// instead of BouncyCastle; TLS only (no legacy AUTH signing); comments for Ash.
package ai.ash.kernel.host.adb

import android.annotation.SuppressLint
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

import okhttp3.tls.HeldCertificate
import java.io.File
import java.math.BigInteger
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.Key
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.security.interfaces.RSAPrivateCrtKey
import java.security.interfaces.RSAPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.RSAKeyGenParameterSpec
import java.security.spec.RSAPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.X509ExtendedKeyManager
import javax.net.ssl.X509ExtendedTrustManager

/**
 * Ash's adb key: the RSA key the phone's wireless debugging knows Ash by once the owner paired them. Whoever holds it can
 * reach this phone's shell while wireless debugging is on, so it never leaves the app: kept encrypted with a key of the
 * Android keystore, in a file outside backups, never logged.
 */
class AdbKey private constructor(private val privateKey: PrivateKey, private val publicKey: RSAPublicKey) {

    /** The public key as adb writes it (`adbkey.pub`): base64 of Android's RSAPublicKey struct, a space, a name, a NUL. */
    fun adbPublicKey(name: String): ByteArray = encodePublicKey(publicKey, name)

    private val certificate: X509Certificate by lazy {
        HeldCertificate.Builder()
            .keyPair(KeyPair(publicKey, privateKey))
            .commonName("00")
            .validityInterval(0L, 2_461_449_600_000L)
            .build()
            .certificate
    }

    /** TLS 1.3 with this key as the client certificate. adbd's own certificate is self-made, so it is not checked here: pairing proves both sides. */
    val sslContext: SSLContext by lazy {
        SSLContext.getInstance("TLSv1.3").apply { init(arrayOf(keyManager), arrayOf(trustAll), SecureRandom()) }
    }

    private val keyManager = object : X509ExtendedKeyManager() {
        override fun chooseClientAlias(keyTypes: Array<out String>, issuers: Array<out Principal>?, socket: Socket?) = if ("RSA" in keyTypes) ALIAS else null
        override fun getCertificateChain(alias: String?) = if (alias == ALIAS) arrayOf(certificate) else null
        override fun getPrivateKey(alias: String?) = if (alias == ALIAS) privateKey else null
        override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?) = null
        override fun getServerAliases(keyType: String, issuers: Array<out Principal>?) = null
        override fun chooseServerAlias(keyType: String, issuers: Array<out Principal>?, socket: Socket?) = null
    }

    @SuppressLint("CustomX509TrustManager", "TrustAllX509TrustManager")
    private val trustAll = object : X509ExtendedTrustManager() {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) {}
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) {}
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) {}
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) {}
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    companion object {
        private const val ALIAS = "key"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val WRAP_ALIAS = "ash_hostshell_adbkey"
        private const val IV = 12
        private val AAD = "ash-adbkey".toByteArray()
        const val MODULUS_BYTES = 2048 / 8

        private fun file(ctx: Context) = File(File(ctx.noBackupFilesDir, "hostshell"), "adbkey")

        /** Ash has paired with this phone before (the owner may still have removed the pairing in the system's list). */
        fun exists(ctx: Context): Boolean = file(ctx).isFile

        /** Forgets the key (「撤销」): the phone's list of paired devices still names Ash until the owner removes it there. */
        fun forget(ctx: Context) {
            file(ctx).delete()
            runCatching { KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(WRAP_ALIAS) }
        }

        /** The key; made (and kept) when there is none yet and [create] is true, else null. */
        @Synchronized
        fun load(ctx: Context, create: Boolean): AdbKey? {
            val f = file(ctx)
            val wrap = wrappingKey()
            if (f.isFile) {
                runCatching {
                    val bytes = f.readBytes()
                    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                    cipher.init(Cipher.DECRYPT_MODE, wrap, GCMParameterSpec(128, bytes, 0, IV))
                    cipher.updateAAD(AAD)
                    return of(KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(cipher.doFinal(bytes, IV, bytes.size - IV))))
                }
                if (!create) return null
            }
            if (!create) return null
            val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(RSAKeyGenParameterSpec(2048, RSAKeyGenParameterSpec.F4)) }.generateKeyPair()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, wrap)
            cipher.updateAAD(AAD)
            val sealed = cipher.doFinal(pair.private.encoded)
            f.parentFile?.mkdirs()
            val tmp = File(f.parentFile, "adbkey.tmp")
            tmp.writeBytes(cipher.iv + sealed)
            if (!tmp.renameTo(f)) throw IllegalStateException("cannot keep the adb key")
            return of(pair.private)
        }

        private fun of(private: PrivateKey): AdbKey {
            val crt = private as RSAPrivateCrtKey
            val public = KeyFactory.getInstance("RSA").generatePublic(RSAPublicKeySpec(crt.modulus, crt.publicExponent)) as RSAPublicKey
            return AdbKey(private, public)
        }

        private fun wrappingKey(): Key {
            val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            ks.getKey(WRAP_ALIAS, null)?.let { return it }
            val spec = KeyGenParameterSpec.Builder(WRAP_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build()
            return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).apply { init(spec) }.generateKey()
        }

        /**
         * Android's `RSAPublicKey` struct (system/core/libcrypto_utils/android_pubkey.c): modulus size in words, n0inv =
         * -1/n[0] mod 2^32, the modulus and rr = 2^(2·bits) mod n as little-endian words, the exponent; base64, then " name\0".
         */
        internal fun encodePublicKey(key: RSAPublicKey, name: String): ByteArray {
            val words = MODULUS_BYTES / 4
            val r32 = BigInteger.ONE.shiftLeft(32)
            val n = key.modulus
            val n0inv = n.mod(r32).modInverse(r32).negate()
            val rr = BigInteger.ONE.shiftLeft(MODULUS_BYTES * 8).modPow(BigInteger.valueOf(2), n)
            val buf = ByteBuffer.allocate(4 + 4 + MODULUS_BYTES * 2 + 4).order(ByteOrder.LITTLE_ENDIAN)
            buf.putInt(words)
            buf.putInt(n0inv.toInt())
            littleEndianWords(n, words).forEach { buf.putInt(it) }
            littleEndianWords(rr, words).forEach { buf.putInt(it) }
            buf.putInt(key.publicExponent.toInt())
            return java.util.Base64.getEncoder().encode(buf.array()) + " $name\u0000".toByteArray()
        }

        private fun littleEndianWords(v: BigInteger, words: Int): IntArray {
            val r32 = BigInteger.ONE.shiftLeft(32)
            var rest = v
            return IntArray(words) { val qr = rest.divideAndRemainder(r32); rest = qr[0]; qr[1].toInt() }
        }
    }
}
