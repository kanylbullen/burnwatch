-- burnwatch schema.
--
-- Two tables with different jobs: `samples` is the change log the forecast is
-- computed from, `heartbeats` is liveness. A collector reporting an unchanged
-- percentage every few seconds writes no sample but is very much alive, and the
-- widget must never mistake an idle user for a dead pipeline.

CREATE TABLE IF NOT EXISTS samples (
  ts         INTEGER NOT NULL,
  window     TEXT    NOT NULL,
  pct        REAL    NOT NULL,
  resets_at  INTEGER NOT NULL,
  host       TEXT    NOT NULL DEFAULT '',
  session_id TEXT,
  model      TEXT,
  PRIMARY KEY (window, ts, host)
);

CREATE INDEX IF NOT EXISTS idx_samples_window_ts ON samples (window, ts);

CREATE TABLE IF NOT EXISTS heartbeats (
  host       TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  model      TEXT,
  PRIMARY KEY (host, session_id)
);

-- Pruning and the "reported recently" query both filter on time alone.
CREATE INDEX IF NOT EXISTS idx_heartbeats_ts ON heartbeats (ts);
