import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Sample } from "../core/compute";
import { config, type WindowKey } from "./config";

export type IngestSample = {
  ts: number;
  window: WindowKey;
  pct: number;
  resets_at: number;
  host: string;
  session_id: string | null;
  model: string | null;
};

export class Store {
  private db: Database;

  constructor(path = config.dbPath) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS samples (
        ts        INTEGER NOT NULL,
        window    TEXT    NOT NULL,
        pct       REAL    NOT NULL,
        resets_at INTEGER NOT NULL,
        host      TEXT    NOT NULL DEFAULT '',
        session_id TEXT,
        model     TEXT,
        PRIMARY KEY (window, ts, host)
      ) WITHOUT ROWID
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_samples_window_ts ON samples (window, ts)",
    );
    // Liveness is tracked apart from the change log: a collector reporting an
    // unchanged percentage every few seconds writes no sample but is very much
    // alive, and the widget must not mistake an idle user for a dead pipeline.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS heartbeats (
        host       TEXT NOT NULL,
        session_id TEXT NOT NULL,
        ts         INTEGER NOT NULL,
        model      TEXT,
        PRIMARY KEY (host, session_id)
      ) WITHOUT ROWID
    `);
  }

  /** Records contact from a collector, whether or not the reading changed. */
  beat(host: string, sessionId: string | null, ts: number, model: string | null): void {
    this.db.run(
      `INSERT INTO heartbeats (host, session_id, ts, model) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (host, session_id) DO UPDATE SET ts = excluded.ts, model = excluded.model`,
      [host, sessionId ?? "", ts, model],
    );
  }

  /**
   * Records a sample. Collectors fire on every status-line render, so identical
   * readings are dropped: a flat stretch is fully described by its endpoints,
   * and `burnRate` measures to `now` rather than to the newest row, so dropping
   * repeats cannot inflate the pace.
   */
  insert(s: IngestSample): boolean {
    const prev = this.db
      .query<{ pct: number; resets_at: number }, [string]>(
        "SELECT pct, resets_at FROM samples WHERE window = ?1 ORDER BY ts DESC LIMIT 1",
      )
      .get(s.window);

    if (prev && prev.pct === s.pct && prev.resets_at === s.resets_at) {
      return false;
    }

    this.db.run(
      `INSERT OR REPLACE INTO samples (ts, window, pct, resets_at, host, session_id, model)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      [s.ts, s.window, s.pct, s.resets_at, s.host, s.session_id, s.model],
    );
    return true;
  }

  private lastPrune = 0;

  /**
   * Drops samples past the retention horizon.
   *
   * Rate-limited to once an hour: this runs from the ingest path, where every
   * status-line render on every machine arrives, and two unindexed DELETE scans
   * over the whole table on each of those serialised the daemon for no benefit.
   * Nothing expires urgently enough to need finer granularity.
   */
  prune(now: number): void {
    if (now - this.lastPrune < 3600) return;
    this.lastPrune = now;
    this.db.run("DELETE FROM samples WHERE ts < ?1", [now - config.retentionS]);
    this.db.run("DELETE FROM heartbeats WHERE ts < ?1", [
      now - config.retentionS,
    ]);
  }

  /** Samples for one window, oldest first, limited to a recent slice. */
  read(window: WindowKey, since: number): Sample[] {
    return this.db
      .query<
        { ts: number; pct: number; resets_at: number },
        [string, number]
      >(
        "SELECT ts, pct, resets_at FROM samples WHERE window = ?1 AND ts >= ?2 ORDER BY ts ASC",
      )
      .all(window, since);
  }

  /** Sessions that reported recently, the hosts they ran on, and last contact. */
  activity(now: number): {
    sessions: number;
    hosts: { name: string; last_seen_s: number; active: boolean }[];
    last_contact_s: number | null;
  } {
    const since = now - config.activeSessionS;
    const row = this.db
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM heartbeats WHERE ts >= ?1 AND session_id <> ''",
      )
      .get(since);
    // Every host ever seen, newest first, each carrying its own age. Dropping
    // the quiet ones would make an idle machine look like a broken one.
    const hosts = this.db
      .query<{ host: string; ts: number }, []>(
        "SELECT host, MAX(ts) AS ts FROM heartbeats WHERE host <> '' GROUP BY host ORDER BY ts DESC",
      )
      .all()
      .map((r) => ({
        name: r.host,
        last_seen_s: Math.max(0, now - r.ts),
        active: r.ts >= since,
      }));
    const last = this.db
      .query<{ ts: number | null }, []>("SELECT MAX(ts) AS ts FROM heartbeats")
      .get();
    return {
      sessions: row?.n ?? 0,
      hosts,
      last_contact_s: last?.ts == null ? null : Math.max(0, now - last.ts),
    };
  }

  close(): void {
    this.db.close();
  }
}
