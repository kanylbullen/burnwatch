//! Replays `core/fixtures/hub.json`, which `core/hub-fixtures.ts` writes from
//! the TypeScript, and requires the same answer to the last bit.

use burnwatch_hub::compute::{compute_window, local_midnight, Opts, Sample};
use burnwatch_hub::ingest::{identity_of, parse_ingest};
use serde_json::{json, Value};

fn fixtures() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../core/fixtures/hub.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap()
}

/// Exact numeric equality, so 42 and 42.0 match but 0.1 + 0.2 and 0.3 do not.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(v, w)| same(v, w))
        }
        _ => a == b,
    }
}

#[test]
fn compute_matches_typescript() {
    let fx = fixtures();
    let cases = fx["compute"].as_array().unwrap();
    assert!(cases.len() > 300);
    let mut failures = vec![];
    for c in cases {
        let samples: Vec<Sample> = c["samples"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| Sample {
                ts: f(&s["ts"]),
                pct: f(&s["pct"]),
                resets_at: f(&s["resets_at"]),
            })
            .collect();
        let o = &c["opts"];
        let opts = Opts {
            now: f(&o["now"]),
            time_zone: o["timeZone"].as_str().unwrap(),
            lookback_s: f(&o["lookbackS"]),
            window_length_s: f(&o["windowLengthS"]),
            on_pace_low: f(&o["onPaceLow"]),
            on_pace_high: f(&o["onPaceHigh"]),
        };
        let got = compute_window(&samples, &opts)
            .map(|w| w.to_json())
            .unwrap_or(Value::Null);
        if !same(&got, &c["expect"]) {
            failures.push(format!(
                "{}:\n  got  {got}\n  want {}",
                c["name"], c["expect"]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

#[test]
fn local_midnight_matches_intl() {
    let fx = fixtures();
    for c in fx["local_midnight"].as_array().unwrap() {
        let got = local_midnight(f(&c["ts"]), c["tz"].as_str().unwrap());
        assert_eq!(got, f(&c["expect"]), "{c}");
    }
}

#[test]
fn ingest_matches_typescript() {
    let fx = fixtures();
    for c in fx["ingest"].as_array().unwrap() {
        let parsed = parse_ingest(&c["body"], f(&c["now"]));
        let got = json!({
            "samples": parsed.samples.iter().map(|s| json!({
                "window": s.window, "pct": s.pct, "resets_at": s.resets_at,
            })).collect::<Vec<_>>(),
            "rejected": parsed.rejected,
            "hadLimits": parsed.had_limits,
        });
        assert!(
            same(&got, &c["expect"]["parsed"]),
            "{}: got {got}, want {}",
            c["name"],
            c["expect"]["parsed"]
        );

        let body = if c["body"].is_null() {
            json!({})
        } else {
            c["body"].clone()
        };
        let who = identity_of(c["host"].as_str().unwrap(), &body);
        let want = &c["expect"]["identity"];
        assert_eq!(json!(who.host), want["host"], "{}", c["name"]);
        assert_eq!(json!(who.session_id), want["sessionId"], "{}", c["name"]);
        assert_eq!(json!(who.model), want["model"], "{}", c["name"]);
    }
}
