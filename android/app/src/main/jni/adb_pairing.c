/*
 * The cryptography of wireless-debugging pairing (the client side): SPAKE2 over the pairing code, then AES-128-GCM keyed by
 * HKDF, as adbd's pairing_auth does, with BoringSSL's own SPAKE2 (the one adbd uses).
 *
 * Adapted from Shizuku (https://github.com/RikkaApps/Shizuku), manager/src/main/jni/adb_pairing.cpp, Apache License 2.0
 * (see THIRD_PARTY_NOTICES.md). Changes: plain C, client role only, JNI names of ai.ash.caps.hostshell.adb.PairingNative.
 */
#include <jni.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <openssl/aead.h>
#include <openssl/curve25519.h>
#include <openssl/digest.h>
#include <openssl/hkdf.h>

/* sizeof() counts the closing NUL, as adbd does. */
static const uint8_t kClientName[] = "adb pair client";
static const uint8_t kServerName[] = "adb pair server";
static const uint8_t kInfo[] = "adb pairing_auth aes-128-gcm key";
#define KEY_LENGTH 16

typedef struct {
    SPAKE2_CTX *spake2;
    uint8_t msg[SPAKE2_MAX_MSG_SIZE];
    size_t msg_size;
    EVP_AEAD_CTX *aead;
    uint64_t enc_sequence;
    uint64_t dec_sequence;
} Pairing;

JNIEXPORT jlong JNICALL Java_ai_ash_caps_hostshell_adb_PairingNative_create(JNIEnv *env, jclass clazz, jbyteArray jPassword) {
    SPAKE2_CTX *spake2 = SPAKE2_CTX_new(spake2_role_alice, kClientName, sizeof(kClientName), kServerName, sizeof(kServerName));
    if (spake2 == NULL) return 0;
    Pairing *p = calloc(1, sizeof(Pairing));
    if (p == NULL) { SPAKE2_CTX_free(spake2); return 0; }
    p->spake2 = spake2;
    jsize size = (*env)->GetArrayLength(env, jPassword);
    jbyte *password = (*env)->GetByteArrayElements(env, jPassword, NULL);
    int ok = SPAKE2_generate_msg(spake2, p->msg, &p->msg_size, sizeof(p->msg), (const uint8_t *) password, (size_t) size);
    (*env)->ReleaseByteArrayElements(env, jPassword, password, JNI_ABORT);
    if (ok != 1 || p->msg_size == 0) { SPAKE2_CTX_free(spake2); free(p); return 0; }
    return (jlong) (intptr_t) p;
}

JNIEXPORT jbyteArray JNICALL Java_ai_ash_caps_hostshell_adb_PairingNative_message(JNIEnv *env, jclass clazz, jlong ptr) {
    Pairing *p = (Pairing *) (intptr_t) ptr;
    jbyteArray out = (*env)->NewByteArray(env, (jsize) p->msg_size);
    (*env)->SetByteArrayRegion(env, out, 0, (jsize) p->msg_size, (const jbyte *) p->msg);
    return out;
}

JNIEXPORT jboolean JNICALL Java_ai_ash_caps_hostshell_adb_PairingNative_initCipher(JNIEnv *env, jclass clazz, jlong ptr, jbyteArray jTheirs) {
    Pairing *p = (Pairing *) (intptr_t) ptr;
    jsize size = (*env)->GetArrayLength(env, jTheirs);
    if (size > SPAKE2_MAX_MSG_SIZE) return JNI_FALSE;
    jbyte *theirs = (*env)->GetByteArrayElements(env, jTheirs, NULL);
    uint8_t material[SPAKE2_MAX_KEY_SIZE];
    size_t material_size = 0;
    int ok = SPAKE2_process_msg(p->spake2, material, &material_size, sizeof(material), (const uint8_t *) theirs, (size_t) size);
    (*env)->ReleaseByteArrayElements(env, jTheirs, theirs, JNI_ABORT);
    if (ok != 1) return JNI_FALSE;
    uint8_t key[KEY_LENGTH];
    if (HKDF(key, sizeof(key), EVP_sha256(), material, material_size, NULL, 0, kInfo, sizeof(kInfo) - 1) != 1) return JNI_FALSE;
    p->aead = EVP_AEAD_CTX_new(EVP_aead_aes_128_gcm(), key, sizeof(key), EVP_AEAD_DEFAULT_TAG_LENGTH);
    return p->aead != NULL ? JNI_TRUE : JNI_FALSE;
}

/* The nonce is the message's sequence number, little-endian, padded with zeros. */
static jbyteArray seal_or_open(JNIEnv *env, Pairing *p, jbyteArray jIn, int seal) {
    if (p->aead == NULL) return NULL;
    jsize in_size = (*env)->GetArrayLength(env, jIn);
    size_t out_cap = (size_t) in_size + (seal ? EVP_AEAD_max_overhead(EVP_aead_aes_128_gcm()) : 0);
    uint8_t *out = malloc(out_cap > 0 ? out_cap : 1);
    if (out == NULL) return NULL;
    uint8_t nonce[EVP_AEAD_MAX_NONCE_LENGTH] = {0};
    size_t nonce_size = EVP_AEAD_nonce_length(EVP_aead_aes_128_gcm());
    uint64_t sequence = seal ? p->enc_sequence : p->dec_sequence;
    memcpy(nonce, &sequence, sizeof(sequence));
    jbyte *in = (*env)->GetByteArrayElements(env, jIn, NULL);
    size_t written = 0;
    int ok = seal
        ? EVP_AEAD_CTX_seal(p->aead, out, &written, out_cap, nonce, nonce_size, (const uint8_t *) in, (size_t) in_size, NULL, 0)
        : EVP_AEAD_CTX_open(p->aead, out, &written, out_cap, nonce, nonce_size, (const uint8_t *) in, (size_t) in_size, NULL, 0);
    (*env)->ReleaseByteArrayElements(env, jIn, in, JNI_ABORT);
    jbyteArray result = NULL;
    if (ok == 1) {
        if (seal) p->enc_sequence++; else p->dec_sequence++;
        result = (*env)->NewByteArray(env, (jsize) written);
        (*env)->SetByteArrayRegion(env, result, 0, (jsize) written, (const jbyte *) out);
    }
    free(out);
    return result;
}

JNIEXPORT jbyteArray JNICALL Java_ai_ash_caps_hostshell_adb_PairingNative_encrypt(JNIEnv *env, jclass clazz, jlong ptr, jbyteArray in) {
    return seal_or_open(env, (Pairing *) (intptr_t) ptr, in, 1);
}

JNIEXPORT jbyteArray JNICALL Java_ai_ash_caps_hostshell_adb_PairingNative_decrypt(JNIEnv *env, jclass clazz, jlong ptr, jbyteArray in) {
    return seal_or_open(env, (Pairing *) (intptr_t) ptr, in, 0);
}

JNIEXPORT void JNICALL Java_ai_ash_caps_hostshell_adb_PairingNative_destroy(JNIEnv *env, jclass clazz, jlong ptr) {
    Pairing *p = (Pairing *) (intptr_t) ptr;
    if (p == NULL) return;
    SPAKE2_CTX_free(p->spake2);
    if (p->aead != NULL) EVP_AEAD_CTX_free(p->aead);
    free(p);
}
