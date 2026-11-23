package io.github.kanylbullen.burnwatch.protocol

import java.io.File
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

/**
 * Recomputes every value in protocol/vectors.json, which the TypeScript
 * reference writes, so passing means this implementation agrees with it byte
 * for byte, not merely that it can talk to itself.
 */
class VectorsTest {
    private val v: JsonObject = Json.parseToJsonElement(
        File(System.getProperty("burnwatch.vectors") ?: "../../protocol/vectors.json").readText(),
    ).jsonObject

    private fun JsonElement.o(k: String) = jsonObject[k]!!
    private fun JsonElement.s(k: String) = o(k).jsonPrimitive.content
    private fun JsonElement.h(k: String) = unhex(s(k))

    private fun unhex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun hex(b: ByteArray) = b.joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }

    @Test
    fun x25519MatchesRfc7748() {
        val r = v.o("x25519").o("rfc7748")
        assertEquals(r.s("alice_pk"), hex(publicKeyOf(r.h("alice_sk"))))
        assertEquals(r.s("bob_pk"), hex(publicKeyOf(r.h("bob_sk"))))
        assertEquals(r.s("shared"), hex(x25519(r.h("alice_sk"), r.h("bob_pk"))))
    }

    @Test
    fun lowOrderKeyIsRefused() {
        val e = assertFailsWith<ProtocolException> {
            x25519(v.o("x25519").o("rfc7748").h("alice_sk"), v.o("x25519").h("low_order_pk"))
        }
        assertEquals("low-order public key", e.message)
    }

    @Test
    fun channel() {
        val c = v.o("channel")
        val ch = Channel(c.h("secret"))
        assertEquals(c.s("channel_id"), hex(ch.channelId))
        assertEquals(c.s("channel_id_b64u"), ch.idB64u)
        assertEquals(c.s("read_token"), hex(ch.readToken))
        assertEquals(c.s("read_token_b64u"), b64u(ch.readToken))
        assertEquals(c.s("read_hash_b64u"), tokenHash(ch.readToken))
        assertEquals(c.s("state_key"), hex(ch.stateKey))
        assertEquals(c.s("write_token_b64u"), b64u(c.h("write_token")))
        assertEquals(c.s("write_hash_b64u"), tokenHash(c.h("write_token")))
    }

    @Test
    fun stateEnvelope() {
        val s = v.o("state")
        val ch = Channel(v.o("channel").h("secret"))
        assertEquals(s.s("envelope"), hex(ch.sealState(s.h("nonce"), s.s("plaintext_utf8"))))

        val body = ch.openState(s.h("envelope"))
        val want = Json.parseToJsonElement(s.s("plaintext_utf8")).jsonObject
        assertEquals(want["issued_at"]!!.jsonPrimitive.long, body.issuedAt)
        assertEquals(want["state"], Json.parseToJsonElement(body.stateJson))

        assertFailsWith<ProtocolException> { ch.openState(s.h("envelope"), body.issuedAt + 1) }
        for ((_, bad) in s.o("reject").jsonObject) {
            assertFailsWith<ProtocolException> { ch.openState(unhex(bad.jsonPrimitive.content)) }
        }
    }

    @Test
    fun codes() {
        val c = v.o("code")
        assertEquals(c.s("code"), codeFromBytes(c.h("bytes")))
        assertEquals(c.s("display"), formatCode(c.s("code")))
        for (case in c.o("normalize").jsonArray) {
            val (typed, want) = case.jsonArray
            assertEquals(if (want is JsonNull) null else want.jsonPrimitive.content, normalizeCode(typed.jsonPrimitive.content))
        }
        repeat(2000) {
            val code = newCode()
            assertEquals(code, normalizeCode(formatCode(code)))
        }
    }

    @Test
    fun pairing() {
        val p = v.o("pairing")
        val dsk = p.h("device_sk")
        val hsk = p.h("hub_sk")
        val dpk = publicKeyOf(dsk)
        val hpk = publicKeyOf(hsk)
        assertEquals(p.s("device_pk"), hex(dpk))
        assertEquals(p.s("hub_pk"), hex(hpk))

        val commit = pairCommit(dpk, p.h("device_nonce"))
        assertEquals(p.s("commit"), hex(commit))
        val t = transcriptHash(p.s("code"), commit, hpk, p.h("hub_nonce"), dpk, p.h("device_nonce"))
        assertEquals(p.s("transcript"), hex(t))
        assertEquals(p.s("sas"), sas(t))
        assertEquals(p.s("sas_display"), formatSas(sas(t)))

        val kD = pairKey(dsk, hpk, t)
        assertEquals(p.s("pair_key"), hex(kD))
        assertContentEquals(kD, pairKey(hsk, dpk, t))

        assertEquals(p.s("seal"), hex(sealPairing(kD, p.h("seal_nonce"), t, p.s("seal_plaintext_utf8"))))
        val opened = openPairing(kD, p.h("seal"), t)
        assertEquals(v.o("channel").s("secret"), hex(opened.secret))
        assertEquals("https://relay.example", opened.relay)

        val other = t.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }
        assertFailsWith<ProtocolException> { openPairing(kD, p.h("seal"), other) }
    }

    @Test
    fun base64urlMustBeCanonical() {
        assertFailsWith<ProtocolException> { unb64u("A") }
        assertFailsWith<ProtocolException> { unb64u("AB+/") }
        assertFailsWith<ProtocolException> { unb64u("A".repeat(21) + "B") }
        assertEquals(16, unb64u("A".repeat(22)).size)
        repeat(200) { n ->
            val b = Primitives.randomBytes(n % 40)
            assertContentEquals(b, unb64u(b64u(b)))
            assertEquals(java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b), b64u(b))
        }
    }

    @Test
    fun formattingRefusesWhatItCannotSlice() {
        for (bad in listOf("", "ABC", "äbcdefgh", "zj3a85e6")) assertFailsWith<ProtocolException> { formatCode(bad) }
        for (bad in listOf("", "12", "1ä2345", "12345a")) assertFailsWith<ProtocolException> { formatSas(bad) }
        assertNull(normalizeCode("ABCD-EFGU"))
    }

    @Test
    fun relayUrls() {
        for (ok in listOf("https://relay.example", "https://relay.example/base/", "http://localhost:8787", "http://127.0.0.1:8787")) {
            assertTrue(validRelayUrl(ok), ok)
        }
        for (no in listOf("", "not a url", "http://relay.example", "https://u:p@relay.example", "https://relay.example/?x=1", "https://relay.example/#f", "file:///etc/passwd", "https://", "https://ex ample", "https://rélay.example")) {
            assertFalse(validRelayUrl(no), no)
        }
    }
}
