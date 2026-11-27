//! Port of `core/compute.ts`, statement for statement.
//!
//! Every quantity is an `f64` because it is a JavaScript number in the
//! original, and the fixtures compare results exactly: the same operations in
//! the same order give the same bits, while a "cleaner" integer rewrite would
//! drift by a rounding step somewhere and the desk would disagree with the
//! Worker. Comments explaining *why* the maths is the way it is live in the
//! TypeScript; they are not repeated here.

use chrono::{TimeZone, Timelike};
use serde_json::{json, Value};

const H: f64 = 3600.0;
const MIN_SPAN_S: f64 = 300.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sample {
    pub ts: f64,
    pub pct: f64,
    pub resets_at: f64,
}

#[derive(Debug, Clone)]
pub struct Opts<'a> {
    pub now: f64,
    pub time_zone: &'a str,
    pub lookback_s: f64,
    pub window_length_s: f64,
    pub on_pace_low: f64,
    pub on_pace_high: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowState {
    pub pct: f64,
    pub resets_at: f64,
    pub resets_in_s: f64,
    pub window_length_s: f64,
    pub rate_pct_per_h: f64,
    pub required_pct_per_h: f64,
    pub pace_ratio: f64,
    pub verdict: &'static str,
    pub speed_up_x: Option<f64>,
    pub runs_out_at: Option<f64>,
    pub early_by_s: Option<f64>,
    pub used_today_pct: Option<f64>,
    pub samples: usize,
    pub last_change_s: f64,
}

/// A JSON number the way JavaScript would print it: integral values without
/// a fraction, so `42` stays `42` and never becomes `42.0` on the wire.
pub fn num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

fn opt(n: Option<f64>) -> Value {
    n.map(num).unwrap_or(Value::Null)
}

impl WindowState {
    /// The same object `computeWindow` returns, field for field.
    pub fn to_json(&self) -> Value {
        json!({
            "pct": num(self.pct),
            "resets_at": num(self.resets_at),
            "resets_in_s": num(self.resets_in_s),
            "window_length_s": num(self.window_length_s),
            "rate_pct_per_h": num(self.rate_pct_per_h),
            "required_pct_per_h": num(self.required_pct_per_h),
            "pace_ratio": num(self.pace_ratio),
            "verdict": self.verdict,
            "speed_up_x": opt(self.speed_up_x),
            "runs_out_at": opt(self.runs_out_at),
            "early_by_s": opt(self.early_by_s),
            "used_today_pct": opt(self.used_today_pct),
            "samples": self.samples,
            "last_change_s": num(self.last_change_s),
        })
    }
}

/// JavaScript's `Math.round`: nearest, with ties towards positive infinity.
/// Rust's `round` sends ties away from zero, which differs below zero.
pub fn js_round(x: f64) -> f64 {
    let r = x.round();
    if x < 0.0 && r - x == -0.5 {
        r + 1.0
    } else {
        r
    }
}

fn round(n: f64, dp: i32) -> f64 {
    let f = 10f64.powi(dp);
    js_round(n * f) / f
}

fn monotonic(samples: &[Sample]) -> Vec<Sample> {
    let mut high = f64::NEG_INFINITY;
    samples
        .iter()
        .map(|s| {
            high = high.max(s.pct);
            Sample { pct: high, ..*s }
        })
        .collect()
}

fn sample_at(samples: &[Sample], at: f64) -> Option<Sample> {
    let mut found = None;
    for s in samples {
        if s.ts <= at {
            found = Some(*s);
        } else {
            break;
        }
    }
    found
}

fn burn_rate(samples: &[Sample], now: f64, lookback_s: f64) -> f64 {
    let Some(latest) = samples.last() else {
        return 0.0;
    };
    let anchor = sample_at(samples, now - lookback_s).unwrap_or(samples[0]);
    let elapsed = now - anchor.ts;
    if elapsed < MIN_SPAN_S {
        return 0.0;
    }
    let delta = latest.pct - anchor.pct;
    if delta < 0.0 {
        return 0.0;
    }
    (delta / elapsed) * H
}

/// Start of the local day containing `ts`, in the same arithmetic as the
/// TypeScript: seconds into the local day, subtracted from the instant. An
/// unknown zone falls back to UTC, which is what the widget does too.
pub fn local_midnight(ts: f64, time_zone: &str) -> f64 {
    let tz: chrono_tz::Tz = time_zone.parse().unwrap_or(chrono_tz::UTC);
    let secs = ts.floor() as i64;
    let Some(t) = tz.timestamp_opt(secs, 0).single() else {
        return ts;
    };
    let into_day = (t.hour() % 24) as f64 * H + t.minute() as f64 * 60.0 + t.second() as f64;
    ts - into_day
}

pub fn compute_window(all: &[Sample], o: &Opts) -> Option<WindowState> {
    if all.is_empty() {
        return None;
    }
    let now = o.now;
    let mut sorted = all.to_vec();
    // Array.prototype.sort is stable, and so is sort_by.
    sorted.sort_by(|a, b| a.ts.partial_cmp(&b.ts).unwrap_or(std::cmp::Ordering::Equal));

    let current_resets_at = sorted
        .iter()
        .map(|s| s.resets_at)
        .fold(f64::NEG_INFINITY, f64::max);
    if current_resets_at <= now {
        return None;
    }

    let filtered: Vec<Sample> = sorted
        .into_iter()
        .filter(|s| s.resets_at == current_resets_at)
        .collect();
    let samples = monotonic(&filtered);
    let latest = *samples.last()?;
    let window_start = current_resets_at - o.window_length_s;

    let resets_in_s = current_resets_at - now;
    let remaining_pct = (100.0 - latest.pct).max(0.0);

    let rate = burn_rate(&samples, now, o.lookback_s);
    let required_rate = if resets_in_s > 0.0 {
        (remaining_pct / resets_in_s) * H
    } else {
        f64::INFINITY
    };

    let pace_ratio = if required_rate > 0.0 && required_rate.is_finite() {
        rate / required_rate
    } else if rate > 0.0 {
        f64::INFINITY
    } else {
        0.0
    };

    let mut speed_up_x = None;
    let mut runs_out_at = None;
    let mut early_by_s = None;

    let verdict = if remaining_pct <= 0.0 {
        runs_out_at = Some(now);
        early_by_s = Some(resets_in_s);
        "runs_out"
    } else if rate <= 0.0 {
        "speed_up"
    } else if pace_ratio > o.on_pace_high {
        let hours_to_100 = remaining_pct / rate;
        let at = js_round(now + hours_to_100 * H);
        runs_out_at = Some(at);
        early_by_s = Some((latest.resets_at - at).max(0.0));
        "runs_out"
    } else if pace_ratio < o.on_pace_low {
        speed_up_x = Some(required_rate / rate);
        "speed_up"
    } else {
        "on_pace"
    };

    let midnight = local_midnight(now, o.time_zone);
    let used_today = if window_start >= midnight {
        Some(latest.pct)
    } else {
        sample_at(&samples, midnight).map(|m| (latest.pct - m.pct).max(0.0))
    };

    Some(WindowState {
        pct: latest.pct,
        resets_at: latest.resets_at,
        resets_in_s,
        window_length_s: o.window_length_s,
        rate_pct_per_h: round(rate, 4),
        required_pct_per_h: if required_rate.is_finite() {
            round(required_rate, 4)
        } else {
            0.0
        },
        pace_ratio: if pace_ratio.is_finite() {
            round(pace_ratio, 4)
        } else {
            0.0
        },
        verdict,
        speed_up_x: speed_up_x.map(|x| round(x, 2)),
        runs_out_at,
        early_by_s,
        used_today_pct: used_today.map(|u| round(u, 2)),
        samples: samples.len(),
        last_change_s: (now - latest.ts).max(0.0),
    })
}

/// Whether `name` is an IANA zone the forecast can cut a day in. Anything
/// else is silently read as UTC by [`local_midnight`], so callers that take a
/// zone from a user should check it first.
pub fn valid_zone(name: &str) -> bool {
    name.parse::<chrono_tz::Tz>().is_ok()
}
