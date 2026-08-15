import type { Sample } from "../core/compute";
import { POLL_HOST, POLL_STALE_S, type WindowKey } from "../core/defaults";

export type IngestSample = {
  ts: number;
  window: WindowKey;
  pct: number;
  resets_at: number;
  host: string;
  session_id: string | null;
  model: string | null;
};

export type Activity = {
  sessions: number;
  /** Machines only. The scheduled poll is reported separately, as `poll`. */
  hosts: { name: string; last_seen_s: number; active: boolean }[];
  /** null when the poll has never run at all. */
  poll: { last_seen_s: number; stale: boolean } | null;
  last_contact_s: number | null;
};

/** D1-backed store. Mirrors daemon/store.ts, minus the local-file concerns. */
export class Store {
  constructor(private db: D1Database) {}

  /** Records contact from a collector, whether or not the reading changed. */
  beatStatement(
    host: string,
    sessionId: string | null,
    ts: number,
    model: string | null,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO heartbeats (host, session_id, ts, model) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (host, session_id) DO UPDATE SET ts = excluded.ts, model = excluded.model`,
      )
      .bind(host, sessionId ?? "", ts, model);
  }

  /**
   * Records a sample unless it repeats the previous reading.
   *
   * The dedupe is expressed as one statement rather than a read followed by a
   * write. Collectors on a dozen machines post concurrently, and a
   * read-then-write would let two requests each see the same "previous" row and
   * both insert — the exact duplicate the check exists to prevent.
   */
  insertStatement(s: IngestSample): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT OR REPLACE INTO samples (ts, window, pct, resets_at, host, session_id, model)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE NOT EXISTS (
           SELECT 1 FROM (
             SELECT pct, resets_at FROM samples WHERE window = ?2 ORDER BY ts DESC LIMIT 1
           ) AS prev
           WHERE prev.pct = ?3 AND prev.resets_at = ?4
         )`,
      )
      .bind(
        s.ts,
        s.window,
        s.pct,
        s.resets_at,
        s.host,
        s.session_id,
        s.model,
      );
  }

  /** Samples for one window, oldest first, from a recent slice. */
  async read(window: WindowKey, since: number): Promise<Sample[]> {
    const { results } = await this.db
      .prepare(
        "SELECT ts, pct, resets_at FROM samples WHERE window = ?1 AND ts >= ?2 ORDER BY ts ASC",
      )
      .bind(window, since)
      .all<Sample>();
    return results ?? [];
  }

  async activity(now: number, activeSessionS: number): Promise<Activity> {
    const since = now - activeSessionS;

    const [sessions, hosts, last] = await this.db.batch([
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM heartbeats WHERE ts >= ?1 AND session_id <> ''",
        )
        .bind(since),
      // Every host ever seen, newest first, each carrying its own age. Dropping
      // the quiet ones would make an idle machine look like a broken one.
      this.db.prepare(
        "SELECT host, MAX(ts) AS ts FROM heartbeats WHERE host <> '' GROUP BY host ORDER BY ts DESC",
      ),
      this.db.prepare("SELECT MAX(ts) AS ts FROM heartbeats"),
    ]);

    const hostRows = (hosts.results ?? []) as { host: string; ts: number }[];
    const lastTs = ((last.results ?? [])[0] as { ts: number | null })?.ts ?? null;

    const pollRow = hostRows.find((r) => r.host === POLL_HOST);

    return {
      sessions: ((sessions.results ?? [])[0] as { n: number })?.n ?? 0,
      hosts: hostRows
        .filter((r) => r.host !== POLL_HOST)
        .map((r) => ({
          name: r.host,
          last_seen_s: Math.max(0, now - r.ts),
          active: r.ts >= since,
        })),
      poll: pollRow
        ? {
            last_seen_s: Math.max(0, now - pollRow.ts),
            stale: now - pollRow.ts > POLL_STALE_S,
          }
        : null,
      last_contact_s: lastTs === null ? null : Math.max(0, now - lastTs),
    };
  }

  /** Drops everything past the retention horizon. Driven by a cron trigger. */
  async prune(now: number, retentionS: number): Promise<void> {
    const cutoff = now - retentionS;
    await this.db.batch([
      this.db.prepare("DELETE FROM samples WHERE ts < ?1").bind(cutoff),
      this.db.prepare("DELETE FROM heartbeats WHERE ts < ?1").bind(cutoff),
    ]);
  }
}
