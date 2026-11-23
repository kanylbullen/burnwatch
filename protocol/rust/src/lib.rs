//! The burnwatch relay protocol, version 1, as specified in
//! `protocol/README.md` and pinned by `protocol/vectors.json`.
//!
//! Like the TypeScript reference, nothing here draws randomness: nonces and
//! keys are passed in, so every function is deterministic and a test vector
//! is just a call with fixed inputs. The hub supplies them from the OS RNG.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

pub const VERSION: u8 = 0x01;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[error("not canonical base64url")]
    Base64,
    #[error("wrong length")]
    Length,
    #[error("low-order public key")]
    LowOrder,
    #[error("envelope too short")]
    Short,
    #[error("unknown envelope version")]
    Version,
    #[error("envelope does not open")]
    Open,
    #[error("malformed plaintext")]
    Plaintext,
    #[error("state rolled back")]
    RolledBack,
    #[error("relay must be an https URL")]
    RelayUrl,
    #[error("code not normalised")]
    Code,
}

pub type Result<T> = std::result::Result<T, Error>;

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hkdf<const N: usize>(ikm: &[u8], salt: &[u8], info: &str) -> [u8; N] {
    let mut out = [0u8; N];
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info.as_bytes(), &mut out)
        .expect("HKDF output length is a small constant");
    out
}

pub fn b64u(b: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(b)
}

/// Decodes base64url and refuses any spelling but the canonical one, to agree
/// with the relay, which compares these values as strings.
pub fn unb64u(s: &str) -> Result<Vec<u8>> {
    let out = URL_SAFE_NO_PAD.decode(s).map_err(|_| Error::Base64)?;
    if b64u(&out) != s {
        return Err(Error::Base64);
    }
    Ok(out)
}

fn array<const N: usize>(b: &[u8]) -> Result<[u8; N]> {
    b.try_into().map_err(|_| Error::Length)
}

// --- X25519 ----------------------------------------------------------------

pub fn public_key_of(sk: &[u8; 32]) -> [u8; 32] {
    PublicKey::from(&StaticSecret::from(*sk)).to_bytes()
}

pub fn x25519(sk: &[u8; 32], peer: &[u8; 32]) -> Result<Zeroizing<[u8; 32]>> {
    let shared = StaticSecret::from(*sk).diffie_hellman(&PublicKey::from(*peer));
    // An all-zero result means the peer sent a low-order point, and the
    // "shared" secret is then known to everyone.
    if !shared.was_contributory() {
        return Err(Error::LowOrder);
    }
    Ok(Zeroizing::new(shared.to_bytes()))
}

// --- Envelopes ---------------------------------------------------------------

pub fn seal(key: &[u8; 32], nonce: &[u8; 12], plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
    let body = Aes256Gcm::new(key.into())
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .expect("AES-GCM encryption of a bounded message cannot fail");
    let mut out = Vec::with_capacity(1 + NONCE_LEN + body.len());
    out.push(VERSION);
    out.extend_from_slice(nonce);
    out.extend_from_slice(&body);
    out
}

pub fn open(key: &[u8; 32], envelope: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    if envelope.len() < 1 + NONCE_LEN + TAG_LEN {
        return Err(Error::Short);
    }
    if envelope[0] != VERSION {
        return Err(Error::Version);
    }
    let (nonce, body) = envelope[1..].split_at(NONCE_LEN);
    Aes256Gcm::new(key.into())
        .decrypt(Nonce::from_slice(nonce), Payload { msg: body, aad })
        .map_err(|_| Error::Open)
}

// --- Channel -------------------------------------------------------------------

/// What every holder of the channel secret can derive.
pub struct Channel {
    pub channel_id: [u8; 16],
    pub read_token: Zeroizing<[u8; 32]>,
    pub state_key: Zeroizing<[u8; 32]>,
}

impl Channel {
    pub fn derive(secret: &[u8; 32]) -> Channel {
        Channel {
            channel_id: hkdf(secret, b"", "burnwatch/v1 channel-id"),
            read_token: Zeroizing::new(hkdf(secret, b"", "burnwatch/v1 read-token")),
            state_key: Zeroizing::new(hkdf(secret, b"", "burnwatch/v1 state-key")),
        }
    }

    pub fn id_b64u(&self) -> String {
        b64u(&self.channel_id)
    }

    fn state_aad(&self) -> Vec<u8> {
        [b"burnwatch/v1 state ".as_slice(), &self.channel_id].concat()
    }

    /// Seals already-serialised plaintext. The hub builds it with
    /// [`state_plaintext`]; vectors pass the exact bytes they expect.
    pub fn seal_state(&self, nonce: &[u8; 12], plaintext: &[u8]) -> Vec<u8> {
        seal(&self.state_key, nonce, plaintext, &self.state_aad())
    }

    /// Opens a state envelope and refuses one issued before the newest this
    /// reader already accepted, since the relay can replay old envelopes.
    pub fn open_state(&self, envelope: &[u8], newest_accepted: i64) -> Result<StatePlaintext> {
        let pt = open(&self.state_key, envelope, &self.state_aad())?;
        let body: StatePlaintext = serde_json::from_slice(&pt).map_err(|_| Error::Plaintext)?;
        if body.v != 1 {
            return Err(Error::Plaintext);
        }
        if body.issued_at < newest_accepted {
            return Err(Error::RolledBack);
        }
        Ok(body)
    }
}

/// base64url SHA-256 of a token, as the relay stores it.
pub fn token_hash(token: &[u8]) -> String {
    b64u(&sha256(&[token]))
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct StatePlaintext {
    pub v: u32,
    pub issued_at: i64,
    pub state: serde_json::Value,
}

pub fn state_plaintext(issued_at: i64, state: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&StatePlaintext {
        v: 1,
        issued_at,
        state,
    })
    .expect("a JSON value always serialises")
}

// --- Pairing codes -----------------------------------------------------------

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Five random bytes as eight Crockford base32 characters.
pub fn code_from_bytes(bits: &[u8; 5]) -> String {
    let n = bits.iter().fold(0u64, |n, &b| (n << 8) | b as u64);
    (0..8)
        .rev()
        .map(|i| CROCKFORD[((n >> (i * 5)) & 31) as usize] as char)
        .collect()
}

pub fn format_code(code: &str) -> String {
    format!("{}-{}", &code[..4], &code[4..])
}

/// What a typed code becomes before it is used anywhere, or `None`.
pub fn normalize_code(typed: &str) -> Option<String> {
    let s: String = typed
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() {
            'I' | 'L' => '1',
            'O' => '0',
            u => u,
        })
        .collect();
    (s.len() == 8 && s.bytes().all(|b| CROCKFORD.contains(&b))).then_some(s)
}

// --- Pairing -------------------------------------------------------------------

pub fn pair_commit(dpk: &[u8; 32], n_d: &[u8; 32]) -> [u8; 32] {
    sha256(&[b"burnwatch/v1 pair-commit", dpk, n_d])
}

pub struct Transcript<'a> {
    pub code: &'a str,
    pub commit: &'a [u8; 32],
    pub hpk: &'a [u8; 32],
    pub n_h: &'a [u8; 32],
    pub dpk: &'a [u8; 32],
    pub n_d: &'a [u8; 32],
}

impl Transcript<'_> {
    pub fn hash(&self) -> Result<[u8; 32]> {
        if normalize_code(self.code).as_deref() != Some(self.code) {
            return Err(Error::Code);
        }
        Ok(sha256(&[
            b"burnwatch/v1 pair-transcript",
            self.code.as_bytes(),
            self.commit,
            self.hpk,
            self.n_h,
            self.dpk,
            self.n_d,
        ]))
    }
}

/// The six-digit number both screens show, unformatted.
pub fn sas(transcript: &[u8; 32]) -> String {
    let h = sha256(&[b"burnwatch/v1 pair-sas", transcript]);
    let n = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) % 1_000_000;
    format!("{n:06}")
}

pub fn format_sas(sas: &str) -> String {
    format!("{} {}", &sas[..3], &sas[3..])
}

pub fn pair_key(
    own_secret: &[u8; 32],
    peer_public: &[u8; 32],
    transcript: &[u8; 32],
) -> Result<Zeroizing<[u8; 32]>> {
    let shared = x25519(own_secret, peer_public)?;
    Ok(Zeroizing::new(hkdf(
        &*shared,
        transcript,
        "burnwatch/v1 pair-key",
    )))
}

fn seal_aad(transcript: &[u8; 32]) -> Vec<u8> {
    [b"burnwatch/v1 pair-seal ".as_slice(), transcript].concat()
}

#[derive(Serialize, Deserialize)]
struct SealPlaintext {
    v: u32,
    relay: String,
    secret: String,
}

pub fn seal_pairing(
    key: &[u8; 32],
    nonce: &[u8; 12],
    transcript: &[u8; 32],
    relay: &str,
    secret: &[u8; 32],
) -> Vec<u8> {
    let pt = Zeroizing::new(
        serde_json::to_vec(&SealPlaintext {
            v: 1,
            relay: relay.to_owned(),
            secret: b64u(secret),
        })
        .expect("a fixed struct always serialises"),
    );
    seal(key, nonce, &pt, &seal_aad(transcript))
}

/// Seals exact plaintext bytes. Only for matching test vectors byte for byte.
pub fn seal_pairing_raw(
    key: &[u8; 32],
    nonce: &[u8; 12],
    transcript: &[u8; 32],
    pt: &[u8],
) -> Vec<u8> {
    seal(key, nonce, pt, &seal_aad(transcript))
}

pub struct Paired {
    pub relay: String,
    pub secret: Zeroizing<[u8; 32]>,
}

pub fn open_pairing(key: &[u8; 32], envelope: &[u8], transcript: &[u8; 32]) -> Result<Paired> {
    let pt = Zeroizing::new(open(key, envelope, &seal_aad(transcript))?);
    let body: SealPlaintext = serde_json::from_slice(&pt).map_err(|_| Error::Plaintext)?;
    if body.v != 1 {
        return Err(Error::Plaintext);
    }
    if !valid_relay_url(&body.relay) {
        return Err(Error::RelayUrl);
    }
    let secret = Zeroizing::new(array::<32>(&unb64u(&body.secret)?)?);
    Ok(Paired {
        relay: body.relay,
        secret,
    })
}

/// `https:` with no credentials, query or fragment; plain `http:` only to
/// this machine, for development.
pub fn valid_relay_url(s: &str) -> bool {
    let Ok(u) = url::Url::parse(s) else {
        return false;
    };
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return false;
    }
    match u.scheme() {
        "https" => u.host_str().is_some(),
        "http" => matches!(u.host_str(), Some("localhost") | Some("127.0.0.1")),
        _ => false,
    }
}
