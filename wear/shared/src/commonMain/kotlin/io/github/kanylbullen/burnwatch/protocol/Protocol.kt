package io.github.kanylbullen.burnwatch.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

/**
 * The burnwatch relay protocol, version 1, for the Kotlin clients.
 *
 * `protocol/README.md` is the contract and `protocol/vectors.json` pins it.
 * Like the TypeScript reference and the Rust crate, the functions here take
 * their randomness as arguments, so the vector tests can call them with fixed
 * inputs. [Primitives.randomBytes] is what real callers pass.
 */
class ProtocolException(message: String) : Exception(message)

private fun fail(message: String): Nothing = throw ProtocolException(message)

const val VERSION: Byte = 0x01
private const val NONCE_LEN = 12
private const val TAG_LEN = 16

private fun label(s: String) = s.encodeToByteArray()

fun sha256(vararg parts: ByteArray): ByteArray =
    Primitives.sha256(parts.fold(ByteArray(0)) { a, b -> a + b })

/** HKDF-SHA256 (RFC 5869), extract then expand. An empty salt is 32 zero bytes. */
fun hkdf(ikm: ByteArray, salt: ByteArray, info: String, length: Int): ByteArray {
    require(length in 1..255 * 32)
    val prk = Primitives.hmacSha256(salt, ikm)
    val out = ByteArray(length)
    var t = ByteArray(0)
    var off = 0
    var i = 1
    while (off < length) {
        t = Primitives.hmacSha256(prk, t + label(info) + byteArrayOf(i.toByte()))
        val n = minOf(t.size, length - off)
        t.copyInto(out, off, 0, n)
        off += n
        i++
    }
    return out
}

// --- base64url ------------------------------------------------------------

private const val B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

fun b64u(b: ByteArray): String = buildString {
    var i = 0
    while (i + 3 <= b.size) {
        val n = (b[i].toInt() and 255 shl 16) or (b[i + 1].toInt() and 255 shl 8) or (b[i + 2].toInt() and 255)
        append(B64[n shr 18 and 63]); append(B64[n shr 12 and 63]); append(B64[n shr 6 and 63]); append(B64[n and 63])
        i += 3
    }
    when (b.size - i) {
        1 -> {
            val n = b[i].toInt() and 255 shl 16
            append(B64[n shr 18 and 63]); append(B64[n shr 12 and 63])
        }
        2 -> {
            val n = (b[i].toInt() and 255 shl 16) or (b[i + 1].toInt() and 255 shl 8)
            append(B64[n shr 18 and 63]); append(B64[n shr 12 and 63]); append(B64[n shr 6 and 63])
        }
    }
}

/** Decodes base64url and refuses every spelling but the canonical one. */
fun unb64u(s: String): ByteArray {
    if (s.length % 4 == 1) fail("not base64url")
    val out = ByteArray(s.length * 3 / 4)
    var acc = 0
    var bits = 0
    var o = 0
    for (c in s) {
        val v = B64.indexOf(c)
        if (v < 0) fail("not base64url")
        acc = (acc shl 6) or v
        bits += 6
        if (bits >= 8) {
            bits -= 8
            out[o++] = (acc shr bits).toByte()
        }
    }
    val result = out.copyOf(o)
    if (b64u(result) != s) fail("not canonical base64url")
    return result
}

// --- X25519 -----------------------------------------------------------------

fun publicKeyOf(secretKey: ByteArray): ByteArray {
    if (secretKey.size != 32) fail("X25519 secret key must be 32 bytes")
    return Primitives.x25519PublicKey(secretKey)
}

fun x25519(secretKey: ByteArray, peer: ByteArray): ByteArray {
    if (secretKey.size != 32) fail("X25519 secret key must be 32 bytes")
    if (peer.size != 32) fail("X25519 public key must be 32 bytes")
    // A low-order peer key gives an all-zero secret that everyone knows. Some
    // implementations throw on it themselves, so both paths end the same way.
    val shared = runCatching { Primitives.x25519(secretKey, peer) }.getOrElse { fail("low-order public key") }
    if (shared.all { it == 0.toByte() }) fail("low-order public key")
    return shared
}

// --- Envelopes ----------------------------------------------------------------

fun seal(key: ByteArray, nonce: ByteArray, plaintext: ByteArray, aad: ByteArray): ByteArray {
    if (key.size != 32) fail("key must be 32 bytes")
    if (nonce.size != NONCE_LEN) fail("nonce must be 12 bytes")
    return byteArrayOf(VERSION) + nonce + Primitives.aesGcmSeal(key, nonce, plaintext, aad)
}

fun open(key: ByteArray, envelope: ByteArray, aad: ByteArray): ByteArray {
    // JCA would quietly run AES-128 or AES-192 on a shorter key.
    if (key.size != 32) fail("key must be 32 bytes")
    if (envelope.size < 1 + NONCE_LEN + TAG_LEN) fail("envelope too short")
    if (envelope[0] != VERSION) fail("unknown envelope version")
    val nonce = envelope.copyOfRange(1, 1 + NONCE_LEN)
    val body = envelope.copyOfRange(1 + NONCE_LEN, envelope.size)
    return runCatching { Primitives.aesGcmOpen(key, nonce, body, aad) }
        .getOrElse { fail("envelope does not open") }
}

// --- Channel ------------------------------------------------------------------

class Channel(secret: ByteArray) {
    init {
        if (secret.size != 32) fail("channel secret must be 32 bytes")
    }

    val channelId: ByteArray = hkdf(secret, ByteArray(0), "burnwatch/v1 channel-id", 16)
    val readToken: ByteArray = hkdf(secret, ByteArray(0), "burnwatch/v1 read-token", 32)
    val stateKey: ByteArray = hkdf(secret, ByteArray(0), "burnwatch/v1 state-key", 32)

    val idB64u: String get() = b64u(channelId)

    private val stateAad get() = label("burnwatch/v1 state ") + channelId

    fun sealState(nonce: ByteArray, plaintextUtf8: String): ByteArray =
        seal(stateKey, nonce, plaintextUtf8.encodeToByteArray(), stateAad)

    /**
     * Opens a state envelope. An envelope issued before [newestAccepted] is
     * refused, because the relay can replay old envelopes even though it
     * cannot forge new ones.
     */
    fun openState(envelope: ByteArray, newestAccepted: Long = 0): StatePlaintext {
        val pt = open(stateKey, envelope, stateAad)
        val body = runCatching {
            Json.parseToJsonElement(pt.decodeToString(throwOnInvalidSequence = true)).jsonObject
        }.getOrElse { fail("malformed state") }
        if (number(body["v"])?.intOrNull != 1) fail("unknown state version")
        val issued = number(body["issued_at"])?.longOrNull ?: fail("missing issued_at")
        if (issued < newestAccepted) fail("state rolled back")
        val state = body["state"] as? JsonObject ?: fail("missing state")
        return StatePlaintext(issued, state.toString())
    }
}

/** A JSON number, never a string that happens to hold digits (as TS sees it). */
private fun number(e: kotlinx.serialization.json.JsonElement?): JsonPrimitive? =
    (e as? JsonPrimitive)?.takeIf { !it.isString && it !is kotlinx.serialization.json.JsonNull }

/** A decrypted state: when the hub issued it, and the `/api/state`-shaped JSON. */
data class StatePlaintext(val issuedAt: Long, val stateJson: String)

fun tokenHash(token: ByteArray): String = b64u(sha256(token))

// --- Pairing codes --------------------------------------------------------------

private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** Five random bytes as eight Crockford base32 characters. */
fun codeFromBytes(bits: ByteArray): String {
    if (bits.size != 5) fail("a pairing code is 5 bytes")
    val n = bits.fold(0L) { acc, b -> (acc shl 8) or (b.toLong() and 255) }
    return (7 downTo 0).map { CROCKFORD[((n shr (it * 5)) and 31).toInt()] }.joinToString("")
}

/** Draws a fresh code. */
fun newCode(): String = codeFromBytes(Primitives.randomBytes(5))

fun formatCode(code: String): String {
    if (normalizeCode(code) != code) fail("code not normalised")
    return "${code.substring(0, 4)}-${code.substring(4)}"
}

fun normalizeCode(typed: String): String? {
    val s = buildString {
        for (c in typed) {
            if (c.isWhitespace() || c == '-') continue
            append(
                when (val u = c.uppercaseChar()) {
                    'I', 'L' -> '1'
                    'O' -> '0'
                    else -> u
                },
            )
        }
    }
    return s.takeIf { it.length == 8 && it.all { c -> c in CROCKFORD } }
}

// --- Pairing ----------------------------------------------------------------------

fun pairCommit(dpk: ByteArray, nD: ByteArray): ByteArray {
    if (dpk.size != 32 || nD.size != 32) fail("dpk and nD must be 32 bytes")
    return sha256(label("burnwatch/v1 pair-commit"), dpk, nD)
}

fun transcriptHash(
    code: String,
    commit: ByteArray,
    hpk: ByteArray,
    nH: ByteArray,
    dpk: ByteArray,
    nD: ByteArray,
): ByteArray {
    if (normalizeCode(code) != code) fail("code not normalised")
    for (v in listOf(commit, hpk, nH, dpk, nD)) if (v.size != 32) fail("transcript values must be 32 bytes")
    return sha256(label("burnwatch/v1 pair-transcript"), label(code), commit, hpk, nH, dpk, nD)
}

/** The six-digit number both screens show, unformatted. */
fun sas(transcript: ByteArray): String {
    val h = sha256(label("burnwatch/v1 pair-sas"), transcript)
    val n = ((h[0].toLong() and 255) shl 24) or ((h[1].toLong() and 255) shl 16) or
        ((h[2].toLong() and 255) shl 8) or (h[3].toLong() and 255)
    return (n % 1_000_000).toString().padStart(6, '0')
}

fun formatSas(sas: String): String {
    if (sas.length != 6 || !sas.all { it in '0'..'9' }) fail("not a six-digit number")
    return "${sas.substring(0, 3)} ${sas.substring(3)}"
}

fun pairKey(ownSecret: ByteArray, peerPublic: ByteArray, transcript: ByteArray): ByteArray =
    hkdf(x25519(ownSecret, peerPublic), transcript, "burnwatch/v1 pair-key", 32)

private fun sealAad(transcript: ByteArray) = label("burnwatch/v1 pair-seal ") + transcript

/** Seals exact plaintext bytes. The hub seals; this exists for the vectors. */
fun sealPairing(key: ByteArray, nonce: ByteArray, transcript: ByteArray, plaintextUtf8: String): ByteArray =
    seal(key, nonce, plaintextUtf8.encodeToByteArray(), sealAad(transcript))

class Paired(val relay: String, val secret: ByteArray)

fun openPairing(key: ByteArray, envelope: ByteArray, transcript: ByteArray): Paired {
    val pt = open(key, envelope, sealAad(transcript))
    try {
        val body = runCatching { Json.parseToJsonElement(pt.decodeToString(throwOnInvalidSequence = true)).jsonObject }
            .getOrElse { fail("malformed seal") }
        if (number(body["v"])?.intOrNull != 1) fail("unknown seal version")
        val relay = (body["relay"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (relay == null || !validRelayUrl(relay)) fail("relay must be an https URL")
        val secretText = (body["secret"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: fail("missing secret")
        val secret = unb64u(secretText)
        if (secret.size != 32) fail("secret must be 32 bytes")
        return Paired(relay, secret)
    } finally {
        pt.fill(0)
    }
}

/**
 * `https:` with a host and no credentials, query or fragment; plain `http:`
 * only to this machine, for development. Written out by hand because common
 * Kotlin has no URL parser, and it errs on the side of refusing.
 */
fun validRelayUrl(s: String): Boolean {
    val (scheme, rest) = when {
        s.startsWith("https://") -> "https" to s.removePrefix("https://")
        s.startsWith("http://") -> "http" to s.removePrefix("http://")
        else -> return false
    }
    // IP-literal hosts are refused outright: no relay needs one, and getting
    // their syntax exactly right by hand is not worth the risk.
    if (rest.any { it == '?' || it == '#' || it == '@' || it == '\\' || it == '[' || it == ']' || it.isWhitespace() || it.code < 0x20 }) return false
    val authority = rest.substringBefore('/')
    val host = authority.substringBefore(':')
    val hasPort = authority.length > host.length
    val port = authority.removePrefix(host).removePrefix(":")
    if (host.isEmpty()) return false
    if (hasPort && (port.isEmpty() || port.length > 5 || !port.all { it in '0'..'9' } || port.toInt() > 65535)) return false
    if (!host.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '-' || it == '.' }) return false
    return scheme == "https" || host == "localhost" || host == "127.0.0.1"
}
