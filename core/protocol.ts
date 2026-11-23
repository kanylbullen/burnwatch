/**
 * Reference implementation of the relay protocol in `protocol/README.md`.
 *
 * Its job is to be obviously correct and to produce `protocol/vectors.json`,
 * which the Rust hub and the Kotlin clients test against. It runs on Bun and
 * Node's crypto module. The relay itself never decrypts anything, so the
 * Worker does not import this file.
 *
 * Randomness is always passed in, never drawn here. That keeps every function
 * deterministic, so a vector is just a call with fixed inputs.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from "node:crypto";

export const VERSION = 0x01;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const label = (s: string) => enc.encode(s);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const sha256 = (...parts: Uint8Array[]): Uint8Array =>
  new Uint8Array(createHash("sha256").update(concat(...parts)).digest());

export const hkdf = (
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
  length: number,
): Uint8Array =>
  new Uint8Array(hkdfSync("sha256", ikm, salt, label(info), length));

export const b64u = (b: Uint8Array): string =>
  Buffer.from(b).toString("base64url");

/**
 * Decodes base64url and refuses every input with a second spelling: wrong
 * alphabet, a length no encoding produces, or spare bits that are not zero.
 * The relay compares these as strings, so it must agree with this.
 */
export function unb64u(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) {
    throw new Error("not base64url");
  }
  const out = new Uint8Array(Buffer.from(s, "base64url"));
  if (b64u(out) !== s) throw new Error("not canonical base64url");
  return out;
}

export const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

export function unhex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) throw new Error("not lowercase hex");
  return new Uint8Array(Buffer.from(s, "hex"));
}

// --- X25519 ---------------------------------------------------------------

// Node takes raw X25519 keys only wrapped in DER. These are the fixed
// prefixes of the PKCS#8 and SPKI encodings for a 32-byte key.
const PKCS8_X25519 = unhex("302e020100300506032b656e04220420");
const SPKI_X25519 = unhex("302a300506032b656e032100");

function privateKey(sk: Uint8Array) {
  if (sk.length !== 32) throw new Error("X25519 secret key must be 32 bytes");
  return createPrivateKey({
    key: Buffer.from(concat(PKCS8_X25519, sk)),
    format: "der",
    type: "pkcs8",
  });
}

export function publicKeyOf(sk: Uint8Array): Uint8Array {
  const der = createPublicKey(privateKey(sk)).export({
    format: "der",
    type: "spki",
  });
  return new Uint8Array(der.subarray(SPKI_X25519.length));
}

export function x25519(sk: Uint8Array, peer: Uint8Array): Uint8Array {
  if (peer.length !== 32) throw new Error("X25519 public key must be 32 bytes");
  // A low-order peer key forces an all-zero result. The spec makes that an
  // error rather than a key, since the "shared" secret is then public. Some
  // runtimes (Bun, recent Node) already refuse it themselves with an error
  // of their own, so both paths end in the same message.
  const priv = privateKey(sk);
  let shared: Uint8Array;
  try {
    shared = new Uint8Array(
      diffieHellman({
        privateKey: priv,
        publicKey: createPublicKey({
          key: Buffer.from(concat(SPKI_X25519, peer)),
          format: "der",
          type: "spki",
        }),
      }),
    );
  } catch {
    throw new Error("low-order public key");
  }
  if (shared.every((b) => b === 0)) throw new Error("low-order public key");
  return shared;
}

// --- Envelopes ------------------------------------------------------------

export function seal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (key.length !== 32) throw new Error("key must be 32 bytes");
  if (nonce.length !== 12) throw new Error("nonce must be 12 bytes");
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad);
  const body = concat(c.update(plaintext), c.final());
  return concat(Uint8Array.of(VERSION), nonce, body, c.getAuthTag());
}

export function open(
  key: Uint8Array,
  envelope: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (envelope.length < 1 + 12 + 16) throw new Error("envelope too short");
  if (envelope[0] !== VERSION) throw new Error("unknown envelope version");
  const nonce = envelope.subarray(1, 13);
  const tag = envelope.subarray(envelope.length - 16);
  const body = envelope.subarray(13, envelope.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return concat(d.update(body), d.final());
}

// --- Channel --------------------------------------------------------------

export type Channel = {
  channelId: Uint8Array;
  readToken: Uint8Array;
  stateKey: Uint8Array;
};

const NO_SALT = new Uint8Array(0);

export function deriveChannel(secret: Uint8Array): Channel {
  if (secret.length !== 32) throw new Error("channel secret must be 32 bytes");
  return {
    channelId: hkdf(secret, NO_SALT, "burnwatch/v1 channel-id", 16),
    readToken: hkdf(secret, NO_SALT, "burnwatch/v1 read-token", 32),
    stateKey: hkdf(secret, NO_SALT, "burnwatch/v1 state-key", 32),
  };
}

export const tokenHash = (token: Uint8Array): string => b64u(sha256(token));

const stateAad = (channelId: Uint8Array) =>
  concat(label("burnwatch/v1 state "), channelId);

export type StatePlaintext = { v: 1; issued_at: number; state: unknown };

export function sealState(
  ch: Channel,
  nonce: Uint8Array,
  body: StatePlaintext,
): Uint8Array {
  return seal(
    ch.stateKey,
    nonce,
    enc.encode(JSON.stringify(body)),
    stateAad(ch.channelId),
  );
}

/**
 * Opens a state envelope and enforces the rollback rule: an envelope issued
 * before the newest one this reader has accepted is refused, because the relay
 * can replay old envelopes even though it cannot forge new ones.
 */
export function openState(
  ch: Channel,
  envelope: Uint8Array,
  newestAccepted = 0,
): StatePlaintext {
  const body = JSON.parse(
    dec.decode(open(ch.stateKey, envelope, stateAad(ch.channelId))),
  );
  if (body?.v !== 1) throw new Error("unknown state version");
  if (typeof body.issued_at !== "number") throw new Error("missing issued_at");
  if (body.issued_at < newestAccepted) throw new Error("state rolled back");
  return body;
}

// --- Pairing --------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Five random bytes (40 bits) as eight Crockford base32 characters. */
export function codeFromBytes(bits: Uint8Array): string {
  if (bits.length !== 5) throw new Error("a pairing code is 5 bytes");
  let n = 0n;
  for (const b of bits) n = (n << 8n) | BigInt(b);
  let out = "";
  for (let i = 7; i >= 0; i--) out += CROCKFORD[Number((n >> BigInt(i * 5)) & 31n)];
  return out;
}

export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** What a typed code becomes before it is used anywhere, or null if invalid. */
export function normalizeCode(typed: string): string | null {
  const s = typed
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(s) ? s : null;
}

export function pairCommit(dpk: Uint8Array, nD: Uint8Array): Uint8Array {
  // Without length framing, the hash is only unambiguous if both are fixed.
  if (dpk.length !== 32 || nD.length !== 32) {
    throw new Error("dpk and nD must be 32 bytes");
  }
  return sha256(label("burnwatch/v1 pair-commit"), dpk, nD);
}

/** The spec's rule for the relay URL inside a seal. */
export function validRelayUrl(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.username || u.password || u.search || u.hash) return false;
  // No relay needs an IPv6 literal, and the Kotlin client, which has no URL
  // parser to lean on, refuses them rather than validate their syntax by hand.
  if (u.hostname.startsWith("[")) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname);
}

export type Transcript = {
  code: string;
  commit: Uint8Array;
  hpk: Uint8Array;
  nH: Uint8Array;
  dpk: Uint8Array;
  nD: Uint8Array;
};

export function transcriptHash(t: Transcript): Uint8Array {
  if (normalizeCode(t.code) !== t.code) throw new Error("code not normalised");
  for (const [k, v] of [
    ["commit", t.commit],
    ["hpk", t.hpk],
    ["nH", t.nH],
    ["dpk", t.dpk],
    ["nD", t.nD],
  ] as const) {
    if (v.length !== 32) throw new Error(`${k} must be 32 bytes`);
  }
  return sha256(
    label("burnwatch/v1 pair-transcript"),
    label(t.code),
    t.commit,
    t.hpk,
    t.nH,
    t.dpk,
    t.nD,
  );
}

/** The six-digit number both screens show. */
export function sas(transcript: Uint8Array): string {
  const h = sha256(label("burnwatch/v1 pair-sas"), transcript);
  const n =
    ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
  return String(n % 1_000_000).padStart(6, "0");
}

export const formatSas = (s: string) => `${s.slice(0, 3)} ${s.slice(3)}`;

export const pairKey = (
  ownSecret: Uint8Array,
  peerPublic: Uint8Array,
  transcript: Uint8Array,
) => hkdf(x25519(ownSecret, peerPublic), transcript, "burnwatch/v1 pair-key", 32);

const sealAad = (transcript: Uint8Array) =>
  concat(label("burnwatch/v1 pair-seal "), transcript);

export type SealPlaintext = { v: 1; relay: string; secret: string };

export function sealPairing(
  key: Uint8Array,
  nonce: Uint8Array,
  transcript: Uint8Array,
  body: SealPlaintext,
): Uint8Array {
  return seal(key, nonce, enc.encode(JSON.stringify(body)), sealAad(transcript));
}

export function openPairing(
  key: Uint8Array,
  envelope: Uint8Array,
  transcript: Uint8Array,
): { relay: string; secret: Uint8Array } {
  const body = JSON.parse(dec.decode(open(key, envelope, sealAad(transcript))));
  if (body?.v !== 1) throw new Error("unknown seal version");
  if (typeof body.relay !== "string" || !validRelayUrl(body.relay)) {
    throw new Error("relay must be an https URL");
  }
  const secret = unb64u(String(body.secret));
  if (secret.length !== 32) throw new Error("secret must be 32 bytes");
  return { relay: body.relay, secret };
}
