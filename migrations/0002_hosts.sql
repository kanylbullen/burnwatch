-- One row per machine, carrying only when it was last heard from.
--
-- The widget lists every host ever seen on every render, and that used to be
-- `SELECT host, MAX(ts) FROM heartbeats GROUP BY host`: a scan of every
-- (host, session) pair in the retention window, once per poll, from every open
-- widget. With a month of sessions behind it that alone walked past the D1 free
-- tier's daily rows_read cap. The answer is a handful of rows, so keep it as a
-- handful of rows and update it on the same ingest that writes the heartbeat.
--
-- Never pruned: a machine that has been quiet for a month is still a machine.

CREATE TABLE IF NOT EXISTS hosts (
  host TEXT    NOT NULL PRIMARY KEY,
  ts   INTEGER NOT NULL
);

-- Backfill from what the heartbeats still hold, so the host list does not go
-- blank between applying this migration and the next ingest.
INSERT OR REPLACE INTO hosts (host, ts)
  SELECT host, MAX(ts) FROM heartbeats WHERE host <> '' GROUP BY host;
