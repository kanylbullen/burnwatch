//! The hub: a store plus the settings it computes with, producing the same
//! `/api/state` object the daemon and the Worker serve.

use serde_json::{json, Map, Value};
use std::sync::Mutex;

use crate::compute::{compute_window, Opts};
use crate::ingest::{identity_of, parse_ingest};
use crate::store::Store;
use crate::{defaults, window_length, WINDOW_KEYS};

pub struct Hub {
    store: Mutex<Store>,
    pub time_zone: String,
}

/// What an ingest did, as the daemon answers it.
pub struct IngestOutcome {
    pub reply: Value,
    /// A reading was stored, so the state has changed.
    pub changed: bool,
}

impl Hub {
    pub fn new(store: Store, time_zone: impl Into<String>) -> Hub {
        Hub {
            store: Mutex::new(store),
            time_zone: time_zone.into(),
        }
    }

    pub fn ingest(
        &self,
        host_header: &str,
        body: &Value,
        now: i64,
    ) -> rusqlite::Result<IngestOutcome> {
        let who = identity_of(host_header, body);
        let parsed = parse_ingest(body, now as f64);
        let mut store = self.store.lock().unwrap_or_else(|e| e.into_inner());
        store.beat(
            &who.host,
            who.session_id.as_deref(),
            now,
            who.model.as_deref(),
        )?;
        let mut recorded = 0;
        for s in &parsed.samples {
            if store.insert(
                now,
                s.window,
                s.pct,
                s.resets_at as i64,
                &who.host,
                who.session_id.as_deref(),
                who.model.as_deref(),
            )? {
                recorded += 1;
            }
        }
        store.prune(now)?;

        let mut reply = Map::new();
        reply.insert("ok".into(), json!(true));
        reply.insert("recorded".into(), json!(recorded));
        if parsed.rejected > 0 {
            reply.insert("rejected".into(), json!(parsed.rejected));
        }
        if !parsed.had_limits {
            reply.insert("reason".into(), json!("no rate_limits in payload"));
        }
        Ok(IngestOutcome {
            reply: Value::Object(reply),
            changed: recorded > 0,
        })
    }

    pub fn state(&self, now: i64) -> rusqlite::Result<Value> {
        let store = self.store.lock().unwrap_or_else(|e| e.into_inner());
        let mut windows = Map::new();
        for key in WINDOW_KEYS {
            let len = window_length(key).expect("tracked windows have a length");
            let lookback = defaults::LOOKBACK_SEVEN_DAY;
            let samples = store.read(key, now - len - lookback)?;
            let w = compute_window(
                &samples,
                &Opts {
                    now: now as f64,
                    time_zone: &self.time_zone,
                    lookback_s: lookback as f64,
                    window_length_s: len as f64,
                    on_pace_low: defaults::ON_PACE_LOW,
                    on_pace_high: defaults::ON_PACE_HIGH,
                },
            );
            windows.insert(key.into(), w.map(|w| w.to_json()).unwrap_or(Value::Null));
        }
        let act = store.activity(now)?;
        Ok(json!({
            "ok": true,
            "now": now,
            "tz": self.time_zone,
            "active_sessions": act.sessions,
            "hosts": act.hosts,
            "poll": null,
            "last_contact_s": act.last_contact_s,
            "windows": windows,
        }))
    }
}
