import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as p from "./protocol";
import { buildVectors } from "./protocol-vectors";

const committed = JSON.parse(
  readFileSync(`${import.meta.dir}/../protocol/vectors.json`, "utf8"),
);
const v = committed;

test("protocol/vectors.json is what the reference implementation produces", () => {
  // If this fails after an intended change: bun run protocol:vectors
  expect(buildVectors()).toEqual(committed);
});

test("X25519 matches RFC 7748 §6.1", () => {
  const r = v.x25519.rfc7748;
  expect(r.alice_pk).toBe(
    "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
  );
  expect(r.bob_pk).toBe(
    "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
  );
  expect(r.shared).toBe(
    "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
  );
});

test("a low-order peer key is refused", () => {
  expect(() =>
    p.x25519(p.unhex(v.x25519.rfc7748.alice_sk), p.unhex(v.x25519.low_order_pk)),
  ).toThrow("low-order");
});

test("state opens, and every reject case fails", () => {
  const ch = p.deriveChannel(p.unhex(v.channel.secret));
  const body = p.openState(ch, p.unhex(v.state.envelope));
  expect(JSON.stringify(body)).toBe(v.state.plaintext_utf8);
  for (const bad of Object.values(v.state.reject) as string[]) {
    expect(() => p.openState(ch, p.unhex(bad))).toThrow();
  }
});

test("a state envelope from another channel does not open", () => {
  const other = p.deriveChannel(p.sha256(new TextEncoder().encode("other")));
  expect(() => p.openState(other, p.unhex(v.state.envelope))).toThrow();
});

test("an older state is refused once a newer one was accepted", () => {
  const ch = p.deriveChannel(p.unhex(v.channel.secret));
  const env = p.unhex(v.state.envelope);
  const issued = JSON.parse(v.state.plaintext_utf8).issued_at;
  expect(p.openState(ch, env, issued).issued_at).toBe(issued);
  expect(() => p.openState(ch, env, issued + 1)).toThrow("rolled back");
});

test("codes normalise as the spec says", () => {
  for (const [typed, want] of v.code.normalize) {
    expect(p.normalizeCode(typed)).toBe(want);
  }
  expect(p.codeFromBytes(p.unhex(v.code.bytes))).toBe(v.code.code);
});

test("every code a device can draw survives normalisation", () => {
  for (let i = 0; i < 2000; i++) {
    const c = p.codeFromBytes(crypto.getRandomValues(new Uint8Array(5)));
    expect(p.normalizeCode(p.formatCode(c))).toBe(c);
  }
});

test("pairing: both sides derive the same key and number, and the seal opens", () => {
  const x = v.pairing;
  const dsk = p.unhex(x.device_sk);
  const hsk = p.unhex(x.hub_sk);
  const t = p.unhex(x.transcript);
  const fromDevice = p.pairKey(dsk, p.unhex(x.hub_pk), t);
  const fromHub = p.pairKey(hsk, p.unhex(x.device_pk), t);
  expect(p.hex(fromDevice)).toBe(x.pair_key);
  expect(p.hex(fromHub)).toBe(x.pair_key);
  expect(x.sas).toMatch(/^\d{6}$/);

  const opened = p.openPairing(fromDevice, p.unhex(x.seal), t);
  expect(p.hex(opened.secret)).toBe(v.channel.secret);
  expect(opened.relay).toBe("https://relay.example");
});

test("a substituted key changes the transcript, the number and the key", () => {
  const x = v.pairing;
  const t = {
    code: x.code,
    commit: p.unhex(x.commit),
    hpk: p.unhex(x.hub_pk),
    nH: p.unhex(x.hub_nonce),
    dpk: p.unhex(x.device_pk),
    nD: p.unhex(x.device_nonce),
  };
  const mitm = p.publicKeyOf(p.sha256(new TextEncoder().encode("mitm")));
  const swapped = p.transcriptHash({ ...t, hpk: mitm });
  expect(p.hex(swapped)).not.toBe(x.transcript);
  expect(() =>
    p.openPairing(p.pairKey(p.unhex(x.device_sk), mitm, swapped), p.unhex(x.seal), swapped),
  ).toThrow();
  // And the commitment catches a swapped device key before any number shows.
  expect(p.hex(p.pairCommit(mitm, t.nD))).not.toBe(x.commit);
});

test("the seal is bound to its transcript", () => {
  const x = v.pairing;
  const other = Uint8Array.from(p.unhex(x.transcript));
  other[0]! ^= 1;
  expect(() =>
    p.openPairing(p.unhex(x.pair_key), p.unhex(x.seal), other),
  ).toThrow();
});

test("decoders refuse malformed and non-canonical input", () => {
  expect(() => p.unb64u("A")).toThrow();
  expect(() => p.unb64u("AB+/")).toThrow();
  // 16 bytes in 22 characters leave 4 spare bits; "B" sets one of them.
  expect(() => p.unb64u("A".repeat(21) + "B")).toThrow("canonical");
  expect(p.unb64u("A".repeat(22)).length).toBe(16);
  expect(() => p.unhex("abc")).toThrow();
  expect(() => p.unhex("zz")).toThrow();
});

test("a bad secret key is reported as such, not as a low-order peer", () => {
  expect(() =>
    p.x25519(new Uint8Array(31), p.unhex(v.x25519.rfc7748.bob_pk)),
  ).toThrow("secret key must be 32 bytes");
});

test("the commitment refuses inputs of the wrong length", () => {
  expect(() => p.pairCommit(new Uint8Array(31), new Uint8Array(33))).toThrow();
});

test("only https relay URLs, or plain http to this machine, are accepted", () => {
  for (const ok of ["https://relay.example", "https://relay.example/base/", "http://localhost:8787", "http://127.0.0.1:8787"]) {
    expect(p.validRelayUrl(ok)).toBe(true);
  }
  for (const no of ["", "not a url", "http://relay.example", "https://u:p@relay.example", "https://relay.example/?x=1", "https://relay.example/#f", "file:///etc/passwd"]) {
    expect(p.validRelayUrl(no)).toBe(false);
  }
});
