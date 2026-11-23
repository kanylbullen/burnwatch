//! Port of `core/ingest.ts`: what the hub accepts from a collector. The
//! reasons for each bound are in the TypeScript.

use serde_json::Value;

const MAX_HOST_LEN: usize = 64;
const MAX_ID_LEN: usize = 128;
const SKEW_S: f64 = 86400.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    pub host: String,
    pub session_id: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValidSample {
    pub window: &'static str,
    pub pct: f64,
    pub resets_at: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedIngest {
    pub samples: Vec<ValidSample>,
    pub rejected: u32,
    pub had_limits: bool,
}

/// `String.prototype.slice(0, n)`, which counts UTF-16 code units. A pair
/// that would be split is dropped whole, since Rust cannot hold half of one.
fn js_slice(s: &str, n: usize) -> String {
    let mut units = 0;
    s.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= n
        })
        .collect()
}

fn as_string(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).unwrap_or("")
}

fn non_empty(s: String) -> Option<String> {
    (!s.is_empty()).then_some(s)
}

pub fn identity_of(host_header: &str, body: &Value) -> Identity {
    let host = js_slice(host_header, MAX_HOST_LEN);
    let session_id = non_empty(js_slice(as_string(body.get("session_id")), MAX_ID_LEN));
    let model = body.get("model");
    let id = as_string(model.and_then(|m| m.get("id")));
    let name = as_string(model.and_then(|m| m.get("display_name")));
    let model = non_empty(js_slice(if id.is_empty() { name } else { id }, MAX_ID_LEN));
    Identity {
        host,
        session_id,
        model,
    }
}

pub fn parse_ingest(body: &Value, now: f64) -> ParsedIngest {
    let empty = ParsedIngest {
        samples: vec![],
        rejected: 0,
        had_limits: false,
    };
    let Some(obj) = body.as_object() else {
        return empty;
    };
    // `typeof x === "object"` is true of an array too, so an array of limits
    // counts as a block that holds no windows rather than as no block.
    let limits = match obj.get("rate_limits") {
        Some(Value::Object(m)) => m,
        Some(Value::Array(_)) => {
            return ParsedIngest {
                had_limits: true,
                ..empty
            }
        }
        _ => return empty,
    };

    let mut samples = vec![];
    let mut rejected = 0;

    for key in crate::WINDOW_KEYS {
        let Some(w) = limits.get(key).and_then(Value::as_object) else {
            continue;
        };
        let (Some(used), Some(reset)) = (
            w.get("used_percentage").and_then(Value::as_f64),
            w.get("resets_at").and_then(Value::as_f64),
        ) else {
            continue;
        };
        if !used.is_finite() || !reset.is_finite() {
            continue;
        }

        let len = crate::window_length(key).expect("tracked windows have a length") as f64;
        if reset < now - len || reset > now + len + SKEW_S {
            rejected += 1;
            continue;
        }
        if !(0.0..=100.0).contains(&used) {
            rejected += 1;
            continue;
        }

        samples.push(ValidSample {
            window: key,
            pct: crate::compute::js_round(used * 100.0) / 100.0,
            resets_at: reset,
        });
    }

    ParsedIngest {
        samples,
        rejected,
        had_limits: true,
    }
}
