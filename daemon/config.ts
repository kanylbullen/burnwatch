import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const H = 3600;
const num = (v: string | undefined, d: number) =>
  v === undefined || v.trim() === "" || Number.isNaN(Number(v)) ? d : Number(v);

/**
 * Loads ~/.burnwatch/env into the environment.
 *
 * The systemd unit passes this file via EnvironmentFile, but nothing else did:
 * starting the daemon by hand — `bun run dev`, a login shell, any other
 * supervisor — silently ignored every setting in it, including the token. That
 * bound 0.0.0.0 with authentication disabled while the file sat there holding
 * a token, which is the opposite of what the file's presence implies.
 *
 * Anything already exported wins, so systemd and one-off overrides still lead.
 */
function loadEnvFile(): void {
  const path =
    process.env.BURNWATCH_CONF ?? join(homedir(), ".burnwatch", "env");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // Absent is normal: the file is optional.
  }

  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key] !== undefined) continue;
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2");
    process.env[key] = value;
  }
}

loadEnvFile();

export const config = {
  port: num(process.env.BURNWATCH_PORT, 8787),
  host: process.env.BURNWATCH_HOST ?? "0.0.0.0",
  dbPath:
    process.env.BURNWATCH_DB ?? join(homedir(), ".burnwatch", "burnwatch.db"),

  /**
   * Shared secret. Collectors send it as `Authorization: Bearer <token>`.
   * Empty disables auth, which is only safe on a loopback-only bind.
   */
  token: process.env.BURNWATCH_TOKEN ?? "",

  timeZone: process.env.BURNWATCH_TZ ?? "Europe/Stockholm",

  /** How far back "current pace" looks, per window. */
  lookback: {
    five_hour: num(process.env.BURNWATCH_LOOKBACK_5H, 1 * H),
    seven_day: num(process.env.BURNWATCH_LOOKBACK_7D, 24 * H),
  },

  /** Nominal window lengths, used to place the window's start. */
  windowLength: {
    five_hour: 5 * H,
    seven_day: 7 * 24 * H,
  },

  /** Pace ratio band that counts as "on pace" rather than under/over. */
  onPaceLow: 0.9,
  onPaceHigh: 1.0,

  /** A session counts as active if it reported within this many seconds. */
  activeSessionS: num(process.env.BURNWATCH_ACTIVE_SESSION_S, 900),

  /** Samples older than this are pruned on write. */
  retentionS: num(process.env.BURNWATCH_RETENTION_S, 30 * 24 * H),
} as const;

export type WindowKey = "five_hour" | "seven_day";
export const WINDOW_KEYS: WindowKey[] = ["five_hour", "seven_day"];
