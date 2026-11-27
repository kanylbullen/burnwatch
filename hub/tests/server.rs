use burnwatch_hub::server::{route, Incoming};
use burnwatch_hub::state::Hub;
use burnwatch_hub::store::Store;
use serde_json::{json, Value};
use tiny_http::Method;

const NOW: i64 = 1_786_000_000;
const PORT: u16 = 8787;
const HOST: &str = "127.0.0.1:8787";

fn hub() -> Hub {
    Hub::new(Store::memory().unwrap(), "Europe/Stockholm")
}

fn send(
    hub: &Hub,
    method: Method,
    path: &str,
    host: Option<&str>,
    origin: Option<&str>,
    body: &[u8],
    now: i64,
) -> (u16, Value, bool) {
    let req = Incoming {
        method: &method,
        path,
        host,
        origin,
        machine: "laptop",
        body,
    };
    route(hub, PORT, &req, now)
}

fn post(hub: &Hub, body: &Value, now: i64) -> (u16, Value, bool) {
    send(
        hub,
        Method::Post,
        "/ingest",
        Some(HOST),
        None,
        body.to_string().as_bytes(),
        now,
    )
}

fn reading(pct: f64) -> Value {
    json!({ "session_id": "s", "rate_limits": { "seven_day": { "used_percentage": pct, "resets_at": NOW + 40 * 3600 } } })
}

#[test]
fn a_reading_is_stored_once_and_shows_in_the_state() {
    let h = hub();
    let (status, reply, changed) = post(&h, &reading(20.0), NOW - 7200);
    assert_eq!((status, changed), (200, true));
    assert_eq!(reply, json!({ "ok": true, "recorded": 1 }));
    // An identical reading is contact, not a sample.
    assert!(!post(&h, &reading(20.0), NOW - 3600).2);
    assert!(post(&h, &reading(24.0), NOW - 60).2);

    let s = h.state(NOW).unwrap();
    assert_eq!(s["windows"]["seven_day"]["pct"], json!(24));
    assert_eq!(s["windows"]["seven_day"]["samples"], json!(2));
    assert_eq!(s["active_sessions"], json!(1));
    assert_eq!(s["hosts"][0]["name"], json!("laptop"));
    assert_eq!(s["poll"], json!(null));
    assert_eq!(s["tz"], json!("Europe/Stockholm"));
}

#[test]
fn a_payload_without_limits_is_contact_with_a_reason() {
    let h = hub();
    let (status, reply, changed) = post(&h, &json!({ "session_id": "s" }), NOW);
    assert_eq!((status, changed), (200, false));
    assert_eq!(reply["reason"], json!("no rate_limits in payload"));
    assert_eq!(h.state(NOW).unwrap()["last_contact_s"], json!(0));
}

#[test]
fn browsers_are_refused() {
    let h = hub();
    let body = reading(5.0).to_string();
    let b = body.as_bytes();
    // A web page posting cross-site always carries Origin.
    assert_eq!(
        send(
            &h,
            Method::Post,
            "/ingest",
            Some(HOST),
            Some("https://evil.example"),
            b,
            NOW
        )
        .0,
        403
    );
    // DNS rebinding: the page's own name pointed at 127.0.0.1.
    assert_eq!(
        send(
            &h,
            Method::Post,
            "/ingest",
            Some("evil.example:8787"),
            None,
            b,
            NOW
        )
        .0,
        403
    );
    assert_eq!(
        send(
            &h,
            Method::Post,
            "/ingest",
            Some("127.0.0.1:9999"),
            None,
            b,
            NOW
        )
        .0,
        403
    );
    assert_eq!(send(&h, Method::Post, "/ingest", None, None, b, NOW).0, 403);
    assert_eq!(h.state(NOW).unwrap()["windows"]["seven_day"], json!(null));
}

#[test]
fn only_ingest_and_healthz_exist() {
    let h = hub();
    let r = |m: Method, p: &str| send(&h, m, p, Some("localhost:8787"), None, b"", NOW).0;
    assert_eq!(r(Method::Get, "/healthz"), 200);
    assert_eq!(r(Method::Get, "/api/state"), 404);
    assert_eq!(r(Method::Get, "/ingest"), 404);
    assert_eq!(r(Method::Post, "/ingest"), 400);
}

#[test]
fn old_samples_are_pruned() {
    let h = hub();
    let old = NOW - 40 * 86400;
    post(
        &h,
        &json!({ "rate_limits": { "seven_day": { "used_percentage": 3.0, "resets_at": old + 3600 } } }),
        old,
    );
    post(&h, &reading(9.0), NOW);
    assert_eq!(
        h.state(NOW).unwrap()["windows"]["seven_day"]["samples"],
        json!(1)
    );
}

#[test]
fn the_listener_answers_over_a_real_socket() {
    use std::io::{Read, Write};
    use std::sync::Arc;
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let hub = Arc::new(hub());
    let (tx, rx) = std::sync::mpsc::channel();
    let h2 = hub.clone();
    let tx = std::sync::Mutex::new(tx);
    std::thread::spawn(move || {
        burnwatch_hub::server::serve(server, h2, port, move || {
            let _ = tx.lock().unwrap().send(());
        })
    });

    let body = json!({ "rate_limits": { "seven_day": { "used_percentage": 12.0, "resets_at": burnwatch_hub::server::now() + 3600 } } }).to_string();
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(s, "POST /ingest HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert!(out.contains("\"recorded\":1"), "{out}");
    rx.recv_timeout(std::time::Duration::from_secs(5))
        .expect("on_change ran");

    let big = "x".repeat(70 * 1024);
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    // The server may answer 413 and close before the whole body is written,
    // which some platforms report as a broken pipe on this side.
    let _ = write!(s, "POST /ingest HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{big}", big.len());
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    assert!(out.starts_with("HTTP/1.1 413"), "{out}");
}

#[test]
fn a_stalled_connection_does_not_block_other_collectors() {
    use std::io::{Read, Write};
    use std::sync::Arc;
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let port = server.server_addr().to_ip().unwrap().port();
    let hub = Arc::new(hub());
    std::thread::spawn(move || burnwatch_hub::server::serve(server, hub, port, || {}));

    // Headers promising a body that never comes. Over 1 KiB on purpose:
    // tiny_http reads smaller bodies ahead on the connection's own thread, so
    // a short stall never reaches a worker and the test would prove nothing.
    let mut stalled = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        stalled,
        "POST /ingest HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 5000\r\n\r\n"
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));

    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    write!(
        s,
        "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    drop(stalled);
}

#[test]
fn only_real_zones_are_valid() {
    use burnwatch_hub::compute::valid_zone;
    assert!(valid_zone("Europe/Stockholm") && valid_zone("UTC"));
    assert!(!valid_zone("") && !valid_zone("-05:00") && !valid_zone("Invalid/Zone"));
}
