package io.github.kanylbullen.burnwatch.protocol

/**
 * The primitives the protocol is built from, one actual per platform family.
 * Everything above them is common code, so a platform only has to get these
 * four right, and the vector tests check that it did.
 */
internal expect object Primitives {
    fun sha256(data: ByteArray): ByteArray
    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray

    /** AES-256-GCM with a 16-byte tag appended to the ciphertext. */
    fun aesGcmSeal(key: ByteArray, nonce: ByteArray, plaintext: ByteArray, aad: ByteArray): ByteArray

    /** Throws if the tag does not verify. */
    fun aesGcmOpen(key: ByteArray, nonce: ByteArray, ciphertext: ByteArray, aad: ByteArray): ByteArray

    fun x25519PublicKey(secretKey: ByteArray): ByteArray

    /** The raw X25519 output; the caller refuses the all-zero result. */
    fun x25519(secretKey: ByteArray, peerPublicKey: ByteArray): ByteArray

    /** Cryptographically secure random bytes. */
    fun randomBytes(n: Int): ByteArray
}
