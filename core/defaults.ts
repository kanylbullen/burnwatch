/**
 * Values shared by every deployment shape.
 *
 * The Bun daemon and the Cloudflare Worker resolve configuration differently —
 * one reads the process environment once at startup, the other is handed an env
 * object per request — but they must agree on what a window *is*. Keeping the
 * lengths and thresholds here stops the two from drifting into disagreeing
 * about the same account.
 */

const H = 3600;

export const WINDOW_KEYS = ["five_hour", "seven_day"] as const;
export type WindowKey = (typeof WINDOW_KEYS)[number];

/** Nominal length of each rate-limit window, as Claude Code defines them. */
export const WINDOW_LENGTH: Record<WindowKey, number> = {
  five_hour: 5 * H,
  seven_day: 7 * 24 * H,
};

/**
 * Host name the scheduled poll reports under.
 *
 * It is reported like a machine because that is how the store works, but it is
 * not one, so clients list it separately: seeing it among your laptops is
 * noise, while not seeing it at all is the thing worth knowing.
 */
export const POLL_HOST = "cloudflare";

/**
 * How long the poll may be silent before it counts as broken. The cron runs
 * quarter-hourly, so this tolerates three missed runs rather than flapping on
 * one.
 */
export const POLL_STALE_S = 45 * 60;

export const DEFAULTS = {
  timeZone: "Europe/Stockholm",

  /** How far back "current pace" looks, per window. */
  lookback: {
    five_hour: 1 * H,
    seven_day: 24 * H,
  } as Record<WindowKey, number>,

  /** Pace ratio band that counts as "on pace" rather than under or over. */
  onPaceLow: 0.9,
  onPaceHigh: 1.0,

  /** A session counts as active if it reported within this many seconds. */
  activeSessionS: 900,

  /** Samples older than this are dropped. */
  retentionS: 30 * 24 * H,
} as const;

/** Reads a numeric setting, falling back when unset, blank or unparseable. */
export function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
