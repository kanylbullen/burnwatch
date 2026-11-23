//! The desktop hub's engine (#7, phase 2): what the Bun daemon does, inside
//! the desktop app, so a single install needs no server at all.
//!
//! - [`ingest`] validates what the status-line collector posts,
//! - [`store`] keeps the samples and heartbeats in SQLite,
//! - [`compute`] turns them into the forecast,
//! - [`server`] listens on loopback for the collector.
//!
//! [`ingest`] and [`compute`] are ports of `core/ingest.ts` and
//! `core/compute.ts`. Their tests replay `core/fixtures/hub.json`, which the
//! TypeScript writes, and must match every number exactly.

pub mod compute;
pub mod ingest;
pub mod server;
pub mod state;
pub mod store;

/// The rate-limit windows tracked, as in `core/defaults.ts`.
pub const WINDOW_KEYS: [&str; 1] = ["seven_day"];
pub const H: i64 = 3600;
pub const WEEK: i64 = 7 * 24 * H;

pub fn window_length(key: &str) -> Option<i64> {
    (key == "seven_day").then_some(WEEK)
}

/// `DEFAULTS` from `core/defaults.ts`.
pub mod defaults {
    use super::H;
    pub const LOOKBACK_SEVEN_DAY: i64 = 24 * H;
    pub const ON_PACE_LOW: f64 = 0.9;
    pub const ON_PACE_HIGH: f64 = 1.0;
    pub const ACTIVE_SESSION_S: i64 = 900;
    pub const RETENTION_S: i64 = 30 * 24 * H;
}
