package io.github.kanylbullen.burnwatch.protocol

import com.google.crypto.tink.subtle.X25519
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Compiled into both the Android and the JVM target (see build.gradle.kts).
 * JCA has SHA-256, HMAC and AES-GCM on every Android version the app
 * supports. X25519 comes from Tink, because JCA only has it from Android 13.
 */
internal actual object Primitives {
    private val random = SecureRandom()

    actual fun sha256(data: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(data)

    actual fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        // HKDF's extract step uses an all-zero key when the salt is empty,
        // and SecretKeySpec refuses an empty array outright.
        mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(32) else key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    actual fun aesGcmSeal(key: ByteArray, nonce: ByteArray, plaintext: ByteArray, aad: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        c.updateAAD(aad)
        return c.doFinal(plaintext)
    }

    actual fun aesGcmOpen(key: ByteArray, nonce: ByteArray, ciphertext: ByteArray, aad: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        c.updateAAD(aad)
        return c.doFinal(ciphertext)
    }

    actual fun x25519PublicKey(secretKey: ByteArray): ByteArray = X25519.publicFromPrivate(secretKey)

    actual fun x25519(secretKey: ByteArray, peerPublicKey: ByteArray): ByteArray =
        X25519.computeSharedSecret(secretKey, peerPublicKey)

    actual fun randomBytes(n: Int): ByteArray = ByteArray(n).also { random.nextBytes(it) }
}
