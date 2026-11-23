//! The loopback listener the status-line collector posts to.
//!
//! It answers `POST /ingest` and `GET /healthz` and nothing else. The widget
//! reads state from the hub directly, never over HTTP, so nothing readable is
//! served here.
//!
//! Loopback is not a security boundary against the browser on the same
//! machine: any web page can send a request to 127.0.0.1. Two checks keep
//! pages out. A browser always sends `Origin` on a cross-site POST, and the
//! collector (curl, PowerShell) never does, so a request carrying one is
//! refused. And the `Host` header must name this listener, which defeats DNS
//! rebinding, where a page's own hostname is pointed at 127.0.0.1.

use serde_json::{json, Value};
use std::io::Read;
use std::sync::Arc;
use tiny_http::{Header, Method, Request, Response, Server};

use crate::state::Hub;

/// Bigger than any status-line payload the collector sends after trimming.
pub const MAX_BODY: u64 = 64 * 1024;

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn header<'a>(req: &'a Request, name: &str) -> Option<&'a str> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

fn reply(status: u16, body: Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(
            Header::from_bytes("content-type", "application/json; charset=utf-8")
                .expect("static header"),
        )
        .with_header(Header::from_bytes("cache-control", "no-store").expect("static header"))
}

/// One request as [`route`] sees it, apart from the socket.
pub struct Incoming<'a> {
    pub method: &'a Method,
    pub path: &'a str,
    pub host: Option<&'a str>,
    pub origin: Option<&'a str>,
    /// `X-Burnwatch-Host`, the machine the collector runs on.
    pub machine: &'a str,
    pub body: &'a [u8],
}

/// The decision for one request, apart from the socket, so it can be tested.
/// Returns the status, the reply, and whether a reading was stored.
pub fn route(hub: &Hub, port: u16, req: &Incoming, now: i64) -> (u16, Value, bool) {
    let Incoming {
        method,
        path,
        host,
        origin,
        machine: host_header,
        body,
    } = *req;
    let allowed_host = matches!(host, Some(h) if h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"));
    if !allowed_host || origin.is_some() {
        return (403, json!({ "ok": false, "error": "forbidden" }), false);
    }
    let path = path.split('?').next().unwrap_or("");
    match (method, path) {
        (Method::Get, "/healthz") => (200, json!({ "ok": true }), false),
        (Method::Post, "/ingest") => {
            let Ok(body) = serde_json::from_slice::<Value>(body) else {
                return (400, json!({ "ok": false, "error": "invalid json" }), false);
            };
            match hub.ingest(host_header, &body, now) {
                Ok(o) => (200, o.reply, o.changed),
                Err(_) => (500, json!({ "ok": false, "error": "store" }), false),
            }
        }
        _ => (404, json!({ "ok": false, "error": "not found" }), false),
    }
}

/// Serves until the listener fails. `on_change` runs after every ingest that
/// stored a reading, which is where the app repaints and publishes.
pub fn serve(server: Server, hub: Arc<Hub>, port: u16, on_change: impl Fn() + Send + 'static) {
    for mut req in server.incoming_requests() {
        let mut body = Vec::new();
        let too_big = req.body_length().is_some_and(|n| n as u64 > MAX_BODY)
            || req
                .as_reader()
                .take(MAX_BODY + 1)
                .read_to_end(&mut body)
                .is_err()
            || body.len() as u64 > MAX_BODY;
        let (status, value, changed) = if too_big {
            (413, json!({ "ok": false, "error": "too large" }), false)
        } else {
            let incoming = Incoming {
                method: req.method(),
                path: req.url(),
                host: header(&req, "Host"),
                origin: header(&req, "Origin"),
                machine: header(&req, "X-Burnwatch-Host").unwrap_or(""),
                body: &body,
            };
            route(&hub, port, &incoming, now())
        };
        let _ = req.respond(reply(status, value));
        if changed {
            on_change();
        }
    }
}
