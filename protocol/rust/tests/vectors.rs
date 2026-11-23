//! Checks this crate against `protocol/vectors.json`, which the TypeScript
//! reference produces. Each value is recomputed here, not just round-tripped,
//! so agreement means the two implementations agree byte for byte.

use burnwatch_protocol::*;
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn h(v: &Value) -> Vec<u8> {
    let s = v.as_str().unwrap();
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn h32(v: &Value) -> [u8; 32] {
    h(v).try_into().unwrap()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[test]
fn x25519_matches_rfc7748() {
    let v = vectors();
    let r = &v["x25519"]["rfc7748"];
    assert_eq!(hex(&public_key_of(&h32(&r["alice_sk"]))), r["alice_pk"]);
    assert_eq!(hex(&public_key_of(&h32(&r["bob_sk"]))), r["bob_pk"]);
    let shared = x25519(&h32(&r["alice_sk"]), &h32(&r["bob_pk"])).unwrap();
    assert_eq!(hex(&*shared), r["shared"]);
}

#[test]
fn low_order_key_is_refused() {
    let v = vectors();
    let sk = h32(&v["x25519"]["rfc7748"]["alice_sk"]);
    assert_eq!(
        x25519(&sk, &h32(&v["x25519"]["low_order_pk"])).unwrap_err(),
        Error::LowOrder
    );
}

#[test]
fn channel_derivation() {
    let v = vectors();
    let c = &v["channel"];
    let ch = Channel::derive(&h32(&c["secret"]));
    assert_eq!(hex(&ch.channel_id), c["channel_id"]);
    assert_eq!(ch.id_b64u(), c["channel_id_b64u"]);
    assert_eq!(hex(&*ch.read_token), c["read_token"]);
    assert_eq!(b64u(&*ch.read_token), c["read_token_b64u"]);
    assert_eq!(token_hash(&*ch.read_token), c["read_hash_b64u"]);
    assert_eq!(hex(&*ch.state_key), c["state_key"]);
    assert_eq!(token_hash(&h(&c["write_token"])), c["write_hash_b64u"]);
    assert_eq!(b64u(&h(&c["write_token"])), c["write_token_b64u"]);
}

#[test]
fn state_envelope() {
    let v = vectors();
    let s = &v["state"];
    let ch = Channel::derive(&h32(&v["channel"]["secret"]));
    let nonce: [u8; 12] = h(&s["nonce"]).try_into().unwrap();
    let pt = s["plaintext_utf8"].as_str().unwrap().as_bytes();
    assert_eq!(hex(&ch.seal_state(&nonce, pt)), s["envelope"]);

    let body = ch.open_state(&h(&s["envelope"]), 0).unwrap();
    let want: StatePlaintext = serde_json::from_slice(pt).unwrap();
    assert_eq!(body, want);
    assert_eq!(
        ch.open_state(&h(&s["envelope"]), want.issued_at + 1)
            .unwrap_err(),
        Error::RolledBack
    );

    for bad in s["reject"].as_object().unwrap().values() {
        assert!(ch.open_state(&h(bad), 0).is_err());
    }
}

#[test]
fn codes() {
    let v = vectors();
    let c = &v["code"];
    let bytes: [u8; 5] = h(&c["bytes"]).try_into().unwrap();
    assert_eq!(code_from_bytes(&bytes), c["code"]);
    assert_eq!(
        format_code(c["code"].as_str().unwrap()).unwrap(),
        c["display"]
    );
    for case in c["normalize"].as_array().unwrap() {
        let got = normalize_code(case[0].as_str().unwrap());
        assert_eq!(got.as_deref(), case[1].as_str(), "{case}");
    }
}

#[test]
fn pairing() {
    let v = vectors();
    let p = &v["pairing"];
    let dsk = h32(&p["device_sk"]);
    let hsk = h32(&p["hub_sk"]);
    let dpk = public_key_of(&dsk);
    let hpk = public_key_of(&hsk);
    assert_eq!(hex(&dpk), p["device_pk"]);
    assert_eq!(hex(&hpk), p["hub_pk"]);

    let n_d = h32(&p["device_nonce"]);
    let n_h = h32(&p["hub_nonce"]);
    let commit = pair_commit(&dpk, &n_d);
    assert_eq!(hex(&commit), p["commit"]);

    let code = p["code"].as_str().unwrap();
    let t = Transcript {
        code,
        commit: &commit,
        hpk: &hpk,
        n_h: &n_h,
        dpk: &dpk,
        n_d: &n_d,
    }
    .hash()
    .unwrap();
    assert_eq!(hex(&t), p["transcript"]);
    assert_eq!(sas(&t), p["sas"]);
    assert_eq!(format_sas(&sas(&t)).unwrap(), p["sas_display"]);

    let k_h = pair_key(&hsk, &dpk, &t).unwrap();
    let k_d = pair_key(&dsk, &hpk, &t).unwrap();
    assert_eq!(hex(&*k_h), p["pair_key"]);
    assert_eq!(*k_h, *k_d);

    let nonce: [u8; 12] = h(&p["seal_nonce"]).try_into().unwrap();
    let pt = p["seal_plaintext_utf8"].as_str().unwrap().as_bytes();
    assert_eq!(hex(&seal_pairing_raw(&k_h, &nonce, &t, pt)), p["seal"]);

    let opened = open_pairing(&k_d, &h(&p["seal"]), &t).unwrap();
    assert_eq!(hex(&*opened.secret), v["channel"]["secret"]);
    assert_eq!(opened.relay, "https://relay.example");

    // The hub's own seal opens on the device side.
    let mine = seal_pairing(&k_h, &nonce, &t, "https://relay.example", &opened.secret);
    assert!(open_pairing(&k_d, &mine, &t).is_ok());
}

#[test]
fn transcript_refuses_an_unnormalised_code() {
    let z = [0u8; 32];
    let t = Transcript {
        code: "zj3a-85e6",
        commit: &z,
        hpk: &z,
        n_h: &z,
        dpk: &z,
        n_d: &z,
    };
    assert_eq!(t.hash().unwrap_err(), Error::Code);
}

#[test]
fn base64url_must_be_canonical() {
    assert!(unb64u("A").is_err());
    assert!(unb64u("AB+/").is_err());
    assert!(unb64u(&format!("{}B", "A".repeat(21))).is_err());
    assert_eq!(unb64u(&"A".repeat(22)).unwrap().len(), 16);
}

#[test]
fn relay_urls() {
    for ok in [
        "https://relay.example",
        "https://relay.example/base/",
        "http://localhost:8787",
        "http://127.0.0.1:8787",
    ] {
        assert!(valid_relay_url(ok), "{ok}");
    }
    for no in [
        "",
        "not a url",
        "http://relay.example",
        "https://u:p@relay.example",
        "https://relay.example/?x=1",
        "https://relay.example/#f",
        "file:///etc/passwd",
        "https://[::1]",
        "http://[::1]:8787",
    ] {
        assert!(!valid_relay_url(no), "{no}");
    }
}

#[test]
fn formatting_refuses_what_it_cannot_slice() {
    for bad in ["", "ABC", "äbcdefgh", "zj3a85e6", "ZJ3A85E6X"] {
        assert!(format_code(bad).is_err(), "{bad}");
    }
    for bad in ["", "12", "1ä2345", "12345a", "1234567"] {
        assert!(format_sas(bad).is_none(), "{bad}");
    }
}
