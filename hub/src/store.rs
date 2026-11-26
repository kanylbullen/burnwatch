//! Samples and heartbeats in SQLite, with the daemon's schema and semantics
//! (`daemon/store.ts`): a reading identical to the previous one is not stored,
//! and contact is tracked apart from readings, so an idle collector is still
//! seen as alive.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;

use crate::compute::Sample;
use crate::defaults;

pub struct Store {
    db: Connection,
    last_prune: i64,
}

pub struct Activity {
    pub sessions: i64,
    pub hosts: Vec<Value>,
    pub last_contact_s: Option<i64>,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        Store::init(Connection::open(path)?)
    }

    pub fn memory() -> rusqlite::Result<Store> {
        Store::init(Connection::open_in_memory()?)
    }

    fn init(db: Connection) -> rusqlite::Result<Store> {
        db.execute_batch(
            "PRAGMA busy_timeout = 5000;
             PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS samples (
               ts INTEGER NOT NULL, window TEXT NOT NULL, pct REAL NOT NULL,
               resets_at INTEGER NOT NULL, host TEXT NOT NULL DEFAULT '',
               session_id TEXT, model TEXT,
               PRIMARY KEY (window, ts, host)
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS idx_samples_window_ts ON samples (window, ts);
             CREATE TABLE IF NOT EXISTS heartbeats (
               host TEXT NOT NULL, session_id TEXT NOT NULL, ts INTEGER NOT NULL,
               model TEXT, PRIMARY KEY (host, session_id)
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS idx_heartbeats_ts ON heartbeats (ts);",
        )?;
        Ok(Store { db, last_prune: 0 })
    }

    pub fn beat(
        &self,
        host: &str,
        session_id: Option<&str>,
        ts: i64,
        model: Option<&str>,
    ) -> rusqlite::Result<()> {
        self.db.execute(
            "INSERT INTO heartbeats (host, session_id, ts, model) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (host, session_id) DO UPDATE SET ts = excluded.ts, model = excluded.model",
            params![host, session_id.unwrap_or(""), ts, model],
        )?;
        Ok(())
    }

    /// Records a reading unless it repeats the newest one. Returns whether it
    /// was written.
    #[allow(clippy::too_many_arguments)]
    pub fn insert(
        &self,
        ts: i64,
        window: &str,
        pct: f64,
        resets_at: f64,
        host: &str,
        session_id: Option<&str>,
        model: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let prev: Option<(f64, f64)> = self
            .db
            .query_row(
                "SELECT pct, resets_at FROM samples WHERE window = ?1 ORDER BY ts DESC LIMIT 1",
                params![window],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if prev == Some((pct, resets_at)) {
            return Ok(false);
        }
        self.db.execute(
            "INSERT OR REPLACE INTO samples (ts, window, pct, resets_at, host, session_id, model)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![ts, window, pct, resets_at, host, session_id, model],
        )?;
        Ok(true)
    }

    /// Drops what is past retention, at most once an hour.
    pub fn prune(&mut self, now: i64) -> rusqlite::Result<()> {
        if now - self.last_prune < 3600 {
            return Ok(());
        }
        self.last_prune = now;
        let horizon = now - defaults::RETENTION_S;
        self.db
            .execute("DELETE FROM samples WHERE ts < ?1", params![horizon])?;
        self.db
            .execute("DELETE FROM heartbeats WHERE ts < ?1", params![horizon])?;
        Ok(())
    }

    pub fn read(&self, window: &str, since: i64) -> rusqlite::Result<Vec<Sample>> {
        let mut q = self.db.prepare_cached(
            "SELECT ts, pct, resets_at FROM samples WHERE window = ?1 AND ts >= ?2 ORDER BY ts ASC",
        )?;
        let rows = q.query_map(params![window, since], |r| {
            Ok(Sample {
                ts: r.get::<_, i64>(0)? as f64,
                pct: r.get(1)?,
                resets_at: r.get(2)?,
            })
        })?;
        rows.collect()
    }

    /// Recent sessions, every host ever seen with its age, and last contact.
    /// There is no scheduled poll in the hub, so no `poll` entry.
    pub fn activity(&self, now: i64) -> rusqlite::Result<Activity> {
        let since = now - defaults::ACTIVE_SESSION_S;
        let sessions = self.db.query_row(
            "SELECT COUNT(*) FROM heartbeats WHERE ts >= ?1 AND session_id <> ''",
            params![since],
            |r| r.get(0),
        )?;
        let mut q = self.db.prepare_cached(
            "SELECT host, MAX(ts) AS ts FROM heartbeats WHERE host <> '' GROUP BY host ORDER BY ts DESC",
        )?;
        let hosts = q
            .query_map([], |r| {
                let name: String = r.get(0)?;
                let ts: i64 = r.get(1)?;
                Ok(json!({ "name": name, "last_seen_s": (now - ts).max(0), "active": ts >= since }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let last: Option<i64> = self
            .db
            .query_row("SELECT MAX(ts) FROM heartbeats", [], |r| r.get(0))?;
        Ok(Activity {
            sessions,
            hosts,
            last_contact_s: last.map(|t| (now - t).max(0)),
        })
    }
}
